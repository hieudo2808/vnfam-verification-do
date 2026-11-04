import { z } from "@hono/zod-openapi";
import * as S from "../contracts";
import { type App, endpoint, intent } from "../http";
import {
    ApiError,
    db,
    device,
    deviceAuth,
    bearer,
    grants,
    publicOperation,
    parse,
    rateLimit,
    type Ctx,
    type OperationRow,
} from "../platform";
import { OperationQuery } from "../cms-contracts";

export async function firmwarePrincipal(c: Ctx) {
    const d = await deviceAuth(
        c.env,
        parse(S.Id, c.req.param("deviceId")),
        bearer(c.req.header("authorization"))
    );
    await rateLimit(c.env, `device:${d.deviceId}`, 600);
    return d;
}
const ActiveOperation = z.strictObject({
    operationId: S.Id,
    action: S.Action,
    state: S.State,
    deadline: S.Time,
});
export const DesiredState = z.strictObject({
    deviceId: S.Id,
    generation: z.number().int(),
    config: S.Config,
    firmwareTarget: S.Id.nullable(),
    serverTimeMs: S.Time,
    activeOperation: ActiveOperation.nullable(),
});
export function deviceRoutes(app: App) {
    app.openAPIRegistry.registerPath({
        method: "get",
        path: "/api/devices/{deviceId}/connection",
        security: [{ DeviceBearer: [] }],
        request: { params: z.object({ deviceId: S.Id }) },
        responses: {
            101: {
                description:
                    "WebSocket v1; see README.md and DeviceMessage/ServerMessage contracts",
            },
            401: { description: "Invalid device credential" },
            422: { description: "WebSocket Upgrade required" },
        },
    });
    app.get("/api/devices/:deviceId/connection", async (c) => {
        const d = await firmwarePrincipal(c);
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
            throw new ApiError(422, "WEBSOCKET_REQUIRED");
        return c.env.DEVICES.getByName(d.deviceId).fetch(c.req.raw);
    });
    endpoint(
        app,
        {
            method: "get",
            path: "/api/devices/{deviceId}/desired-state",
            output: DesiredState,
            summary: "Authenticated own-device desired state",
        },
        async (c) => {
            const d = await firmwarePrincipal(c);
            const activeOperation = await db(c.env)
                .prepare(
                    "SELECT operationId,action,state,deadline FROM operations WHERE deviceId=? AND generation=? AND action!='REQUEST_STATUS' AND state IN('CREATED','SENT','ACKNOWLEDGED','RUNNING','UNKNOWN')"
                )
                .bind(d.deviceId, d.generation)
                .first();
            return c.json({
                deviceId: d.deviceId,
                generation: d.generation,
                config: {
                    revision: d.configRevision,
                    scopeId: d.scopeId,
                    qrBaseUrl: d.qrBaseUrl,
                    appliedRevision: d.appliedRevision,
                },
                firmwareTarget: d.firmwareTarget,
                serverTimeMs: Date.now(),
                activeOperation,
            });
        }
    );
    for (const kind of ["commands", "upgrades"] as const) {
        endpoint(
            app,
            {
                method: "post",
                path: `/api/admin/devices/{deviceId}/${kind}`,
                permission: "commands:write",
                input: kind === "commands" ? S.CommandInput : S.UpgradeInput,
                output: S.Operation,
                status: 202,
                summary: `Create durable ${kind} intent; no offline queue`,
            },
            async (c, input) => {
                const deviceId = c.req.param("deviceId")!,
                    d = await device(c.env, deviceId);
                grants(c.get("principal"), d.siteId, d.scopeId);
                const action =
                    kind === "commands" ? S.CommandInput.parse(input).action : "UPGRADE_FIRMWARE";
                const i = await intent(c, `${kind}:${deviceId}`, input);
                const result = await c.env.DEVICES.getByName(deviceId).startOperation(
                    deviceId,
                    action,
                    i,
                    c.get("principal"),
                    c.get("actorId"),
                    kind === "upgrades" ? S.UpgradeInput.parse(input).releaseId : undefined
                );
                if (result.error) throw new ApiError(result.error.status, result.error.code);
                if (result.replayed) c.header("idempotency-replayed", "true");
                return c.json(result.operation, 202);
            }
        );
    }
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/operations",
            permission: "devices:read",
            query: OperationQuery,
            output: S.pageOf(S.Operation),
            summary: "Operation history across generations; optional client-scoped intent lookup",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const q = parse(OperationQuery, c.req.query());
            const rows = await db(c.env)
                .prepare(
                    "SELECT o.* FROM operations o WHERE deviceId=? AND operationId>? AND (? IS NULL OR EXISTS(SELECT 1 FROM idempotency i WHERE i.clientId=? AND i.key=? AND json_extract(i.response,'$.operationId')=o.operationId)) AND (? IS NULL OR action=?) AND (? IS NULL OR state=?) AND createdAt>=? AND createdAt<? ORDER BY operationId LIMIT ?"
                )
                .bind(
                    d.deviceId,
                    q.cursor ?? "",
                    q.intentKey ?? null,
                    c.get("principal").clientId,
                    q.intentKey ?? null,
                    q.action ?? null,
                    q.action ?? null,
                    q.state ?? null,
                    q.state ?? null,
                    q.fromMs ?? 0,
                    q.toMs ?? Number.MAX_SAFE_INTEGER,
                    q.limit + 1
                )
                .all<OperationRow>();
            return c.json({
                items: rows.results.slice(0, q.limit).map(publicOperation),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.operationId : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/operations/{operationId}",
            permission: "devices:read",
            output: S.Operation,
            summary: "Read authoritative operation state",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const op = await db(c.env)
                .prepare("SELECT * FROM operations WHERE deviceId=? AND operationId=?")
                .bind(d.deviceId, c.req.param("operationId")!)
                .first<OperationRow>();
            if (!op) throw new ApiError(404, "OPERATION_NOT_FOUND");
            return c.json(publicOperation(op));
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/events",
            permission: "audit:read",
            query: S.PageQuery,
            output: S.pageOf(S.Audit),
            summary: "Redacted device audit events",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const q = parse(S.PageQuery, c.req.query());
            const rows = await db(c.env)
                .prepare(
                    "SELECT eventId,deviceId,siteId,scopeId,clientId,actorId,action,createdAt,detail FROM audit WHERE deviceId=? AND siteId IN(SELECT value FROM json_each(?)) AND scopeId IN(SELECT value FROM json_each(?)) AND eventId>? ORDER BY eventId LIMIT ?"
                )
                .bind(
                    d.deviceId,
                    JSON.stringify(c.get("principal").sites),
                    JSON.stringify(c.get("principal").scopes),
                    q.cursor ?? "",
                    q.limit + 1
                )
                .all<{ eventId: string }>();
            return c.json({
                items: rows.results.slice(0, q.limit),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.eventId : null,
            });
        }
    );
}
