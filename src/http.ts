import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv, Ctx } from "./platform";
import { ApiError, db, parse, service } from "./platform";
import { ErrorBody, Id } from "./contracts";
import { canonical, hash } from "./crypto";

export type App = OpenAPIHono<AppEnv>;
export function endpoint<I extends z.ZodType, O extends z.ZodType>(
    app: App,
    spec: {
        method: "get" | "post" | "patch" | "put" | "delete";
        path: string;
        permission?: string;
        input?: I;
        query?: z.ZodObject;
        output: O;
        status?: 200 | 201 | 202;
        summary: string;
    },
    handler: (c: Ctx, input: z.infer<I>) => Promise<Response>
) {
    const params = Object.fromEntries(
        [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, Id])
    );
    app.openAPIRegistry.registerPath(
        createRoute({
            method: spec.method,
            path: spec.path,
            summary: spec.summary,
            security: spec.permission
                ? [{ ServiceBearer: [] }]
                : spec.path.startsWith("/api/devices/")
                  ? [{ DeviceBearer: [] }]
                  : [],
            request: {
                ...(spec.permission
                    ? {
                          headers: z.object({
                              "x-actor-id": Id,
                              "x-actor-name": z.string().max(2400).optional(),
                              ...(spec.method === "get" ? {} : { "idempotency-key": Id }),
                          }),
                      }
                    : {}),
                ...(Object.keys(params).length ? { params: z.object(params) } : {}),
                ...(spec.input
                    ? {
                          body: {
                              required: true,
                              content: { "application/json": { schema: spec.input } },
                          },
                      }
                    : {}),
                ...(spec.query ? { query: spec.query } : {}),
            },
            responses: {
                default: {
                    description: "Unexpected failure",
                    content: { "application/json": { schema: ErrorBody } },
                },
                [spec.status ?? 200]: {
                    description: "Success",
                    content: { "application/json": { schema: spec.output } },
                },
                ...Object.fromEntries(
                    [401, 403, 404, 409, 410, 413, 422, 429, 503].map((status) => [
                        status,
                        {
                            description: "Error",
                            content: { "application/json": { schema: ErrorBody } },
                        },
                    ])
                ),
            },
        })
    );
    app.on(spec.method, spec.path.replaceAll(/\{(\w+)\}/g, ":$1"), async (c: Context<AppEnv>) => {
        if (spec.permission) await service(c, spec.permission);
        if (Object.keys(params).length) parse(z.object(params), c.req.param());
        if (spec.query) parse(spec.query, c.req.query());
        const input = spec.input ? parse(spec.input, await c.req.json()) : undefined;
        const response = await handler(c, input as z.infer<I>);
        if (
            response.headers.get("content-type")?.includes("application/json") &&
            response.status < 300
        )
            spec.output.parse(await response.clone().json());
        return response;
    });
}
export function intent(c: Ctx, action: string, input: unknown) {
    const key = parse(Id, c.req.header("idempotency-key"));
    return hash(canonical({ action, input })).then((fingerprint) => ({
        key,
        fingerprint,
        clientId: c.get("principal").clientId,
        action,
    }));
}
export type Intent = Awaited<ReturnType<typeof intent>>;
export async function replay(
    env: Env,
    i: Intent
): Promise<{ response: string; status: number } | null> {
    const row = await db(env)
        .prepare("SELECT * FROM idempotency WHERE clientId=? AND key=?")
        .bind(i.clientId, i.key)
        .first<Intent & { response: string; status: number }>();
    if (!row) return null;
    if (row.action !== i.action || row.fingerprint !== i.fingerprint)
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
    return row;
}
export function replayResponse(row: { response: string; status: number }) {
    return new Response(row.response, {
        status: row.status,
        headers: { "content-type": "application/json", "idempotency-replayed": "true" },
    });
}
export const changed = (env: Env) =>
    env.DB.prepare("INSERT INTO transaction_guard VALUES(changes())");
export function claim(env: Env, i: Intent, response: unknown, status: number) {
    return env.DB.prepare("INSERT INTO idempotency VALUES(?,?,?,?,?,?)").bind(
        i.clientId,
        i.key,
        i.action,
        i.fingerprint,
        JSON.stringify(response),
        status
    );
}
export async function commit(
    c: Ctx,
    action: string,
    input: unknown,
    response: unknown,
    statements: D1PreparedStatement[],
    status = 200,
    storedResponse = response
) {
    const i = await intent(c, action, input),
        existing = await replay(c.env, i);
    if (existing) return replayResponse(existing);
    try {
        await db(c.env).batch([
            claim(c.env, i, storedResponse, status),
            c.env.DB.prepare(
                "INSERT INTO transaction_guard SELECT count(*) FROM service_credentials WHERE credentialId=? AND revokedAt IS NULL"
            ).bind(c.get("principal").credentialId),
            ...statements,
            c.env.DB.prepare("DELETE FROM transaction_guard"),
        ]);
    } catch (e) {
        const race = await replay(c.env, i);
        if (race) return replayResponse(race);
        if (String(e).includes("constraint failed") || String(e).includes("CONSTRAINT"))
            throw new ApiError(409, "STATE_CONFLICT");
        throw e;
    }
    return Response.json(response, { status });
}
