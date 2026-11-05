import { z } from "@hono/zod-openapi";
import * as S from "../contracts";
import { type App, endpoint, commit, intent, replay, replayResponse, changed } from "../http";
import { ApiError, audit, db, device, grants, parse } from "../platform";
import { qrBytes, verifyDeviceSignature } from "../crypto";
import { HistoryQuery, CheckInSummary } from "../cms-contracts";

export function checkInRoutes(app: App) {
    endpoint(
        app,
        {
            method: "post",
            path: "/api/check-ins",
            permission: "checkins:write",
            input: S.CheckInInput,
            output: S.Receipt,
            status: 201,
            summary: "Verify signed presence and record receipt",
        },
        async (c, input) => {
            const p = c.get("principal"),
                i = await intent(c, "checkin:create", input),
                old = await replay(c.env, i);
            if (old) {
                const receipt = S.Receipt.parse(JSON.parse(old.response));
                const stored = await db(c.env)
                    .prepare(
                        "SELECT siteId,scopeId FROM check_ins WHERE checkInId=? AND clientId=?"
                    )
                    .bind(receipt.checkInId, p.clientId)
                    .first<{ siteId: string; scopeId: string }>();
                if (!stored) throw new ApiError(503, "STORAGE_UNAVAILABLE");
                grants(p, stored.siteId, stored.scopeId);
                return replayResponse(old);
            }
            const q = input.qr,
                d = await device(c.env, q.deviceId);
            grants(p, d.siteId, input.scopeId);
            const key = await db(c.env)
                .prepare(
                    "SELECT publicKey FROM qr_keys WHERE keyId=? AND deviceId=? AND generation=? AND state='ACTIVE'"
                )
                .bind(q.keyId, d.deviceId, d.generation)
                .first<{ publicKey: string }>();
            const policy = await db(c.env)
                .prepare("SELECT maxAgeMs,futureSkewMs FROM qr_policy WHERE id=1")
                .first<{ maxAgeMs: number; futureSkewMs: number }>();
            const now = Date.now(),
                age = now - q.issuedAtMs;
            if (
                !policy ||
                !key ||
                !d.credentialHash ||
                !d.checkInEnabled ||
                q.scopeId !== input.scopeId ||
                d.scopeId !== input.scopeId ||
                age > policy.maxAgeMs ||
                age < -policy.futureSkewMs ||
                !(await verifyDeviceSignature(key.publicKey, q.signature, qrBytes(q)))
            )
                throw new ApiError(422, "QR_INVALID");
            const response = {
                checkInId: crypto.randomUUID(),
                subjectId: input.subjectId,
                scopeId: input.scopeId,
                deviceId: d.deviceId,
                qrIssuedAtMs: q.issuedAtMs,
                verifiedAtMs: now,
            };
            try {
                return await commit(
                    c,
                    i.action,
                    input,
                    response,
                    [
                        c.env.DB.prepare(
                            `INSERT INTO check_ins(checkInId,clientId,subjectId,scopeId,deviceId,siteId,qrIssuedAtMs,verifiedAtMs,subjectName) SELECT ?,?,?,?,?,?,?,?,? FROM devices d JOIN qr_keys k ON k.deviceId=d.deviceId AND k.generation=d.generation JOIN qr_policy p ON p.id=1 JOIN service_credentials s ON s.credentialId=?
                WHERE d.deviceId=? AND d.scopeId=? AND d.siteId=? AND d.checkInEnabled=1 AND d.credentialHash IS NOT NULL AND d.generation=? AND k.keyId=? AND k.state='ACTIVE' AND s.revokedAt IS NULL
                AND d.siteId IN (SELECT value FROM json_each(s.sites)) AND d.scopeId IN (SELECT value FROM json_each(s.scopes)) AND ? BETWEEN -p.futureSkewMs AND p.maxAgeMs`
                        ).bind(
                            response.checkInId,
                            p.clientId,
                            input.subjectId,
                            input.scopeId,
                            d.deviceId,
                            d.siteId,
                            q.issuedAtMs,
                            now,
                            input.subjectName ?? null,
                            p.credentialId,
                            d.deviceId,
                            input.scopeId,
                            d.siteId,
                            d.generation,
                            q.keyId,
                            age
                        ),
                        changed(c.env),
                        audit(
                            c.env,
                            p,
                            c.get("actorId"),
                            "CHECK_IN_ACCEPTED",
                            d,
                            JSON.stringify({ checkInId: response.checkInId })
                        ),
                    ],
                    201
                );
            } catch (e) {
                if (e instanceof ApiError && e.code === "STATE_CONFLICT")
                    throw new ApiError(422, "QR_INVALID");
                throw e;
            }
        }
    );
    const latestQuery = z.object({ subjectId: S.Id, scopeId: S.Id });
    endpoint(
        app,
        {
            method: "get",
            path: "/api/check-ins/latest",
            permission: "checkins:read",
            query: latestQuery,
            output: S.Receipt.nullable(),
            summary: "Latest receipt in caller namespace",
        },
        async (c) => {
            const q = parse(latestQuery, c.req.query()),
                p = c.get("principal");
            if (!p.scopes.includes(q.scopeId)) throw new ApiError(403, "FORBIDDEN");
            const receipt = await db(c.env)
                .prepare(
                    "SELECT checkInId,subjectId,scopeId,deviceId,qrIssuedAtMs,verifiedAtMs FROM check_ins WHERE clientId=? AND subjectId=? AND scopeId=? AND siteId IN (SELECT value FROM json_each(?)) ORDER BY verifiedAtMs DESC,checkInId DESC LIMIT 1"
                )
                .bind(p.clientId, q.subjectId, q.scopeId, JSON.stringify(p.sites))
                .first();
            return c.json(receipt);
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/check-in-policy",
            permission: "audit:read",
            output: S.Policy,
            summary: "Read global QR policy",
        },
        async (c) =>
            c.json(await db(c.env).prepare("SELECT maxAgeMs,futureSkewMs FROM qr_policy").first())
    );
    endpoint(
        app,
        {
            method: "patch",
            path: "/api/admin/check-in-policy",
            permission: "policy:write",
            input: S.Policy,
            output: S.Policy,
            summary: "Operator-only global QR window",
        },
        async (c, input) => {
            if (c.get("principal").kind !== "OPERATOR") throw new ApiError(403, "FORBIDDEN");
            return commit(c, "policy:update", input, input, [
                c.env.DB.prepare("UPDATE qr_policy SET maxAgeMs=?,futureSkewMs=? WHERE id=1").bind(
                    input.maxAgeMs,
                    input.futureSkewMs
                ),
                changed(c.env),
                audit(
                    c.env,
                    c.get("principal"),
                    c.get("actorId"),
                    "POLICY_CHANGED",
                    undefined,
                    JSON.stringify(input)
                ),
            ]);
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/check-in-summaries",
            permission: "audit:read",
            query: HistoryQuery,
            output: S.pageOf(CheckInSummary),
            summary: "Named check-in history for CMS; legacy receipt shape remains unchanged",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(HistoryQuery, c.req.query());
            const search = (value?: string) => "%" + (value ?? "").replace(/[\\%_]/g, "\\$&") + "%";
            const rows = await db(c.env)
                .prepare(
                    `SELECT c.checkInId,c.subjectId,c.scopeId,c.deviceId,c.qrIssuedAtMs,c.verifiedAtMs,c.subjectName,d.name deviceName FROM check_ins c LEFT JOIN devices d ON d.deviceId=c.deviceId AND d.siteId=c.siteId AND d.scopeId=c.scopeId
            WHERE c.siteId IN(SELECT value FROM json_each(?)) AND c.scopeId IN(SELECT value FROM json_each(?)) AND c.checkInId>? AND (? IS NULL OR c.deviceId=?) AND (? IS NULL OR c.subjectId=?) AND (? IS NULL OR c.siteId=?) AND (? IS NULL OR c.scopeId=?) AND c.verifiedAtMs>=? AND c.verifiedAtMs<? AND (? IS NULL OR d.name LIKE ? ESCAPE '\\') AND (? IS NULL OR c.subjectName LIKE ? ESCAPE '\\') ORDER BY c.checkInId LIMIT ?`
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    q.deviceId ?? null,
                    q.deviceId ?? null,
                    q.subjectId ?? null,
                    q.subjectId ?? null,
                    q.siteId ?? null,
                    q.siteId ?? null,
                    q.scopeId ?? null,
                    q.scopeId ?? null,
                    q.fromMs ?? 0,
                    q.toMs ?? Number.MAX_SAFE_INTEGER,
                    q.deviceName ?? null,
                    search(q.deviceName),
                    q.subjectName ?? null,
                    search(q.subjectName),
                    q.limit + 1
                )
                .all<z.infer<typeof CheckInSummary>>();
            const config = c.env as Env & { REGISTRATION_SCOPE_NAME?: string },
                scopeName = S.DisplayName.safeParse(config.REGISTRATION_SCOPE_NAME);
            return c.json({
                items: rows.results.slice(0, q.limit).map((row) => ({
                    ...row,
                    scopeName:
                        row.scopeId === config.REGISTRATION_SCOPE_ID && scopeName.success
                            ? scopeName.data
                            : null,
                })),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.checkInId : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/check-ins",
            permission: "audit:read",
            query: HistoryQuery,
            output: S.pageOf(S.Receipt),
            summary: "Authorized check-in audit",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(HistoryQuery, c.req.query());
            const rows = await db(c.env)
                .prepare(
                    "SELECT checkInId,subjectId,scopeId,deviceId,qrIssuedAtMs,verifiedAtMs FROM check_ins WHERE siteId IN (SELECT value FROM json_each(?)) AND scopeId IN (SELECT value FROM json_each(?)) AND checkInId>? AND (? IS NULL OR deviceId=?) AND (? IS NULL OR subjectId=?) AND (? IS NULL OR siteId=?) AND (? IS NULL OR scopeId=?) AND verifiedAtMs>=? AND verifiedAtMs<? ORDER BY checkInId LIMIT ?"
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    q.deviceId ?? null,
                    q.deviceId ?? null,
                    q.subjectId ?? null,
                    q.subjectId ?? null,
                    q.siteId ?? null,
                    q.siteId ?? null,
                    q.scopeId ?? null,
                    q.scopeId ?? null,
                    q.fromMs ?? 0,
                    q.toMs ?? Number.MAX_SAFE_INTEGER,
                    q.limit + 1
                )
                .all<{ checkInId: string }>();
            return c.json({
                items: rows.results.slice(0, q.limit),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.checkInId : null,
            });
        }
    );
}
