import type { Context } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { hash } from "./crypto";
import type { z } from "@hono/zod-openapi";
import { Device, Operation, DisplayName } from "./contracts";

export class ApiError extends Error {
    constructor(
        public status: 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503,
        public code: string,
        message = code
    ) {
        super(message);
    }
}
export interface Principal {
    actorName?: string;
    credentialId: string;
    clientId: string;
    kind: string;
    permissions: string[];
    sites: string[];
    scopes: string[];
}
export type AppEnv = {
    Bindings: Env & { CONFIG_ENCRYPTION_KEY?: string };
    Variables: RequestIdVariables & { principal: Principal; actorId: string };
};
export type Ctx = Context<AppEnv>;
export type DeviceRow = Omit<z.infer<typeof Device>, "checkInEnabled" | "capabilities"> & {
    checkInEnabled: number;
    capabilities: string;
    credentialHash: string | null;
    currentSession: string | null;
    reportedHealthy: number;
    sessionEpoch: number;
    deletedAt: number | null;
};
export type OperationRow = Omit<z.infer<typeof Operation>, "payload" | "result"> & {
    payload: string;
    result: string | null;
};
export const db = (env: Env) => env.DB.withSession("first-primary");
export async function service(c: Ctx, permission: string): Promise<Principal> {
    const token = bearer(c.req.header("authorization"));
    const row = await db(c.env)
        .prepare("SELECT * FROM service_credentials WHERE tokenHash=? AND revokedAt IS NULL")
        .bind(await hash(token))
        .first<{
            credentialId: string;
            clientId: string;
            kind: string;
            permissions: string;
            sites: string;
            scopes: string;
        }>();
    if (!row) throw new ApiError(401, "UNAUTHORIZED");
    const p: Principal = {
        ...row,
        permissions: JSON.parse(row.permissions),
        sites: JSON.parse(row.sites),
        scopes: JSON.parse(row.scopes),
    };
    if (!p.permissions.includes(permission)) throw new ApiError(403, "FORBIDDEN");
    if (p.kind === "MINIGAME" && !["checkins:read", "checkins:write"].includes(permission))
        throw new ApiError(403, "FORBIDDEN");
    c.set("principal", p);
    const actorId = c.req.header("x-actor-id");
    if (!actorId || !/^[A-Za-z0-9_-]{1,128}$/.test(actorId))
        throw new ApiError(422, "ACTOR_REQUIRED");
    c.set("actorId", actorId);
    const name = c.req.header("x-actor-name");
    if (name !== undefined) {
        if (name.length > 2400) throw new ApiError(422, "ACTOR_INVALID");
        let decoded: string;
        try {
            decoded = decodeURIComponent(name);
        } catch {
            throw new ApiError(422, "ACTOR_INVALID");
        }
        const parsed = DisplayName.safeParse(decoded);
        if (!parsed.success) throw new ApiError(422, "ACTOR_INVALID");
        p.actorName = parsed.data;
    }
    await rateLimit(c.env, `service:${p.credentialId}`, 1200);
    return p;
}
export function bearer(header?: string): string {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!m?.[1]) throw new ApiError(401, "UNAUTHORIZED");
    return m[1];
}
export function grants(p: Principal, siteId: string, scopeId: string) {
    if (!p.sites.includes(siteId) || !p.scopes.includes(scopeId))
        throw new ApiError(403, "FORBIDDEN");
}
export async function device(
    env: Env,
    deviceId: string,
    includeDeleted = false
): Promise<DeviceRow> {
    const row = await db(env)
        .prepare("SELECT * FROM devices WHERE deviceId=? AND (?=1 OR deletedAt IS NULL)")
        .bind(deviceId, includeDeleted ? 1 : 0)
        .first<DeviceRow>();
    if (!row) throw new ApiError(404, "DEVICE_NOT_FOUND");
    return row;
}
export function publicDevice(d: DeviceRow): z.infer<typeof Device> {
    const safe = Object.fromEntries(
        Object.keys(Device.shape)
            .filter((k) => k !== "online")
            .map((k) => [k, d[k as keyof DeviceRow]])
    );
    return Device.parse({
        ...safe,
        checkInEnabled: Boolean(d.checkInEnabled),
        capabilities: JSON.parse(d.capabilities),
    });
}
export async function deviceAuth(env: Env, deviceId: string, token: string) {
    const d = await device(env, deviceId);
    if (!d.credentialHash || d.credentialHash !== (await hash(token)))
        throw new ApiError(401, "UNAUTHORIZED");
    return d;
}
export function publicOperation(o: OperationRow): z.infer<typeof Operation> {
    return { ...o, payload: JSON.parse(o.payload), result: o.result ? JSON.parse(o.result) : null };
}
export function audit(
    env: Env,
    p: { clientId: string; actorName?: string },
    actorId: string,
    action: string,
    d?: { deviceId: string; siteId: string; scopeId: string },
    detail = "{}"
) {
    return env.DB.prepare(
        "INSERT INTO audit(eventId,deviceId,siteId,scopeId,clientId,actorId,action,createdAt,detail,actorName) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).bind(
        crypto.randomUUID(),
        d?.deviceId ?? null,
        d?.siteId ?? null,
        d?.scopeId ?? null,
        p.clientId,
        actorId,
        action,
        Date.now(),
        detail,
        p.actorName ?? null
    );
}
export async function rateLimit(env: Env, key: string, max: number) {
    const bucket = Math.floor(Date.now() / 60_000);
    const result = await db(env)
        .prepare(
            "INSERT INTO rate_limits(key,bucket,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END RETURNING count"
        )
        .bind(key, bucket)
        .first<{ count: number }>();
    if (!result || result.count > max) throw new ApiError(429, "RATE_LIMITED");
}
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR");
    return parsed.data;
}
