import { endpoint, type App } from "../http";
import {
    db,
    device,
    grants,
    publicDevice,
    publicOperation,
    type DeviceRow,
    type OperationRow,
    parse,
    ApiError,
} from "../platform";
import * as C from "../cms-contracts";
import * as S from "../contracts";
import type { z } from "@hono/zod-openapi";

type SummaryRow = DeviceRow & {
    _connection: string | null;
    _observedAt: number | null;
    _identity: string;
    _operation: string | null;
};
const identity =
    "CASE WHEN d.generation=0 THEN 'UNPAIRED' WHEN d.credentialHash IS NULL THEN 'REPAIR_REQUIRED' WHEN d.confirmedAt IS NULL THEN 'AWAITING_BOOT' ELSE 'CONFIRMED' END";
const connection = "CASE WHEN p.observedAt>=? THEN p.state ELSE 'UNKNOWN' END";
const select =
    "SELECT d.*,p.state _connection,p.observedAt _observedAt," +
    identity +
    " _identity,(SELECT json_object('operationId',operationId,'deviceId',deviceId,'generation',generation,'action',action,'source',source,'state',state,'createdAt',createdAt,'deadline',deadline,'ackDeadline',ackDeadline,'payload',json(payload),'result',json(result),'actorId',actorId,'clientId',clientId) FROM operations o WHERE o.deviceId=d.deviceId AND o.generation=d.generation AND o.action!='REQUEST_STATUS' AND o.state IN('CREATED','SENT','ACKNOWLEDGED','RUNNING','UNKNOWN') LIMIT 1) _operation FROM devices d LEFT JOIN device_presence p ON p.deviceId=d.deviceId AND p.generation=d.generation AND p.sessionId IS d.currentSession ";
function summary(r: SummaryRow): z.infer<typeof C.Summary> {
    return C.Summary.parse({
        device: publicDevice(r),
        identity: r._identity,
        connection: {
            state:
                r._observedAt !== null && r._observedAt >= Date.now() - 90000
                    ? r._connection
                    : "UNKNOWN",
            observedAt: r._observedAt,
        },
        activeOperation: r._operation ? JSON.parse(r._operation) : null,
    });
}
export function cmsRoutes(app: App) {
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/context",
            permission: "devices:read",
            output: C.Context,
            summary: "REQ-CMS-01: service context, no credentials",
        },
        async (c) => {
            const p = c.get("principal");
            return c.json({
                clientId: p.clientId,
                sites: p.sites,
                scopes: p.scopes,
                permissions: p.permissions,
                serverTimeMs: Date.now(),
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/device-summaries",
            permission: "devices:read",
            query: C.DeviceQuery,
            output: S.pageOf(C.Summary),
            summary: "REQ-CMS-02: filtered device snapshots, no DO fan-out",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(C.DeviceQuery, c.req.query()),
                search = "%" + (q.q ?? "").replace(/[\\%_]/g, "\\$&") + "%";
            const rows = await db(c.env)
                .prepare(
                    select +
                        "WHERE d.deletedAt IS NULL AND d.siteId IN(SELECT value FROM json_each(?)) AND d.scopeId IN(SELECT value FROM json_each(?)) AND d.deviceId>? AND (d.name LIKE ? ESCAPE '\\' OR d.deviceId LIKE ? ESCAPE '\\') AND (? IS NULL OR d.siteId=?) AND (? IS NULL OR d.scopeId=?) AND (? IS NULL OR " +
                        identity +
                        "=?) AND (? IS NULL OR d.checkInEnabled=?) AND (? IS NULL OR " +
                        connection +
                        "=?) ORDER BY d.deviceId LIMIT ?"
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    search,
                    search,
                    q.siteId ?? null,
                    q.siteId ?? null,
                    q.scopeId ?? null,
                    q.scopeId ?? null,
                    q.identity ?? null,
                    q.identity ?? null,
                    q.accepting ?? null,
                    q.accepting === "true" ? 1 : 0,
                    q.connection ?? null,
                    Date.now() - 90000,
                    q.connection ?? null,
                    q.limit + 1
                )
                .all<SummaryRow>();
            return c.json({
                items: rows.results.slice(0, q.limit).map(summary),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.deviceId : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/overview",
            permission: "devices:read",
            output: C.Overview,
            summary: "REQ-CMS-02: live detail, safe pairing/key metadata and durable progress",
        },
        async (c) => {
            let d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            await c.env.DEVICES.getByName(d.deviceId).observeConnection(d.deviceId);
            d = await device(c.env, d.deviceId);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const r = await db(c.env)
                .prepare(select + "WHERE d.deviceId=?")
                .bind(d.deviceId)
                .first<SummaryRow>();
            if (!r) throw new ApiError(404, "DEVICE_NOT_FOUND");
            const pairing = await db(c.env)
                .prepare(
                    "SELECT pairingId,generation,expiresAt,attempts,CASE WHEN state='PENDING' AND expiresAt<? THEN 'EXPIRED' ELSE state END state FROM pairings WHERE deviceId=? ORDER BY createdAt DESC,pairingId DESC LIMIT 1"
                )
                .bind(Date.now(), d.deviceId)
                .first();
            const keys = await db(c.env)
                .prepare(
                    "SELECT keyId,publicKey,generation,state,createdAt FROM qr_keys WHERE deviceId=? ORDER BY createdAt DESC LIMIT 100"
                )
                .bind(d.deviceId)
                .all();
            const ops = await db(c.env)
                .prepare(
                    "SELECT o.*,p.percent _percent,p.updatedAt _updatedAt FROM operations o LEFT JOIN operation_progress p USING(operationId) WHERE o.deviceId=? ORDER BY o.createdAt DESC,o.operationId DESC LIMIT 10"
                )
                .bind(d.deviceId)
                .all<OperationRow & { _percent: number | null; _updatedAt: number | null }>();
            const synced = await db(c.env)
                .prepare(
                    "SELECT json_extract(result,'$.syncedAtMs') ts FROM operations WHERE deviceId=? AND generation=? AND action='SYNC_TIME' AND state='SUCCEEDED' ORDER BY createdAt DESC LIMIT 1"
                )
                .bind(d.deviceId, d.generation)
                .first<{ ts: number }>();
            return c.json({
                ...summary(r),
                config: {
                    revision: d.configRevision,
                    scopeId: d.scopeId,
                    qrBaseUrl: d.qrBaseUrl,
                    appliedRevision: d.appliedRevision,
                },
                pairing,
                keys: keys.results,
                recentOperations: ops.results.map(({ _percent, _updatedAt, ...op }) => ({
                    operation: publicOperation(op),
                    progress:
                        _percent === null ? null : { percent: _percent, updatedAt: _updatedAt },
                })),
                lastSyncedAtMs: synced?.ts ?? null,
                serverTimeMs: Date.now(),
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/audit-events",
            permission: "audit:read",
            query: C.HistoryQuery,
            output: S.pageOf(S.Audit),
            summary: "REQ-CMS-06: filtered redacted audit across authorized devices",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(C.HistoryQuery, c.req.query());
            const rows = await db(c.env)
                .prepare(
                    "SELECT eventId,deviceId,siteId,scopeId,clientId,actorId,action,createdAt,detail FROM audit WHERE (siteId IS NULL OR siteId IN(SELECT value FROM json_each(?))) AND (scopeId IS NULL OR scopeId IN(SELECT value FROM json_each(?))) AND eventId>? AND createdAt>=? AND createdAt<? AND (? IS NULL OR deviceId=?) AND (? IS NULL OR action=?) AND (? IS NULL OR siteId=?) AND (? IS NULL OR scopeId=?) ORDER BY eventId LIMIT ?"
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    q.fromMs ?? 0,
                    q.toMs ?? Number.MAX_SAFE_INTEGER,
                    q.deviceId ?? null,
                    q.deviceId ?? null,
                    q.action ?? null,
                    q.action ?? null,
                    q.siteId ?? null,
                    q.siteId ?? null,
                    q.scopeId ?? null,
                    q.scopeId ?? null,
                    q.limit + 1
                )
                .all<z.infer<typeof S.Audit>>();
            return c.json({
                items: rows.results.slice(0, q.limit),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.eventId : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/audit-summaries",
            permission: "audit:read",
            query: C.HistoryQuery,
            output: S.pageOf(C.AuditSummary),
            summary: "Named and scoped CMS audit with operation context",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(C.HistoryQuery, c.req.query()),
                search = "%" + (q.deviceName ?? "").replace(/[\\%_]/g, "\\$&") + "%";
            const detail = "CASE WHEN json_valid(a.detail) THEN a.detail ELSE '{}' END";
            const rows = await db(c.env)
                .prepare(
                    `SELECT a.eventId,a.deviceId,a.siteId,a.scopeId,a.clientId,a.actorId,a.action,a.createdAt,a.detail,
            d.name deviceName,CASE WHEN a.clientId='device' AND a.actorId=a.deviceId THEN d.name ELSE a.actorName END actorName,o.action operationAction,o.state operationState,r.version firmwareVersion,ci.subjectName
            FROM audit a LEFT JOIN devices d ON d.deviceId=a.deviceId AND d.siteId=a.siteId AND d.scopeId=a.scopeId
            LEFT JOIN operations o ON o.operationId=json_extract(${detail},'$.operationId') AND o.deviceId=a.deviceId
            LEFT JOIN firmware_releases r ON r.releaseId=json_extract(${detail},'$.releaseId')
            LEFT JOIN check_ins ci ON ci.checkInId=json_extract(${detail},'$.checkInId') AND ci.siteId=a.siteId AND ci.scopeId=a.scopeId
            WHERE (a.siteId IS NULL OR a.siteId IN(SELECT value FROM json_each(?))) AND (a.scopeId IS NULL OR a.scopeId IN(SELECT value FROM json_each(?))) AND a.eventId>? AND a.createdAt>=? AND a.createdAt<? AND (? IS NULL OR a.deviceId=?) AND (? IS NULL OR a.action=?) AND (? IS NULL OR a.siteId=?) AND (? IS NULL OR a.scopeId=?) AND (? IS NULL OR d.name LIKE ? ESCAPE '\\') ORDER BY a.eventId LIMIT ?`
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    q.fromMs ?? 0,
                    q.toMs ?? Number.MAX_SAFE_INTEGER,
                    q.deviceId ?? null,
                    q.deviceId ?? null,
                    q.action ?? null,
                    q.action ?? null,
                    q.siteId ?? null,
                    q.siteId ?? null,
                    q.scopeId ?? null,
                    q.scopeId ?? null,
                    q.deviceName ?? null,
                    search,
                    q.limit + 1
                )
                .all<z.infer<typeof C.AuditSummary>>();
            return c.json({
                items: rows.results.slice(0, q.limit),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.eventId : null,
            });
        }
    );
}
