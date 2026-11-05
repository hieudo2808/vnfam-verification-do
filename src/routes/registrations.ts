import { z } from "@hono/zod-openapi";
import * as R from "../registration-contracts";
import * as S from "../contracts";
import { type App, endpoint, commit, changed, intent, replay, replayResponse } from "../http";
import { ApiError, audit, db, device, grants, parse, rateLimit, type Ctx } from "../platform";
import { hash, randomToken, unb64, verifyDeviceSignature } from "../crypto";

type RegistrationRow = {
    registrationId: string;
    siteId: string;
    scopeId: string;
    publicKey: string;
    keyId: string;
    hardwareTarget: string;
    serial: string | null;
    nonce: string;
    secretHash: string;
    state: z.infer<typeof R.RegistrationState>;
    attempts: number;
    deviceId: string | null;
    createdAt: number;
    expiresAt: number;
};
type RegistrationEnv = Env & { REGISTRATION_SITE_ID?: string; REGISTRATION_SCOPE_ID?: string };
function meta(row: RegistrationRow) {
    return R.RegistrationMeta.parse({
        ...Object.fromEntries(
            Object.keys(R.RegistrationMeta.shape).map((key) => [
                key,
                row[key as keyof RegistrationRow],
            ])
        ),
        state:
            ["CHALLENGE", "PENDING", "APPROVED"].includes(row.state) && row.expiresAt < Date.now()
                ? "EXPIRED"
                : row.state,
    });
}
async function registration(c: Ctx) {
    const row = await db(c.env)
        .prepare("SELECT * FROM device_registrations WHERE registrationId=?")
        .bind(c.req.param("registrationId")!)
        .first<RegistrationRow>();
    if (!row) throw new ApiError(404, "REGISTRATION_NOT_FOUND");
    return row;
}
async function access(c: Ctx, claimSecret: string) {
    await rateLimit(c.env, "registration:poll:global", 1200);
    const row = await registration(c);
    if ((await hash(claimSecret)) !== row.secretHash) throw new ApiError(401, "UNAUTHORIZED");
    await rateLimit(c.env, "registration:" + row.registrationId, 30);
    return row;
}
async function proof(c: Ctx, row: RegistrationRow, signature: string, phase: "SUBMIT" | "CLAIM") {
    if (row.expiresAt < Date.now()) throw new ApiError(410, "REGISTRATION_EXPIRED");
    if (row.state === "LOCKED") throw new ApiError(409, "REGISTRATION_LOCKED");
    if (!(await verifyDeviceSignature(row.publicKey, signature, R.registrationBytes(phase, row)))) {
        await db(c.env)
            .prepare(
                "UPDATE device_registrations SET attempts=attempts+1,state=CASE WHEN attempts+1>=5 THEN 'LOCKED' ELSE state END WHERE registrationId=? AND state IN('CHALLENGE','PENDING','APPROVED')"
            )
            .bind(row.registrationId)
            .run();
        throw new ApiError(422, "PROOF_INVALID");
    }
}
const alive = (c: Ctx, row: RegistrationRow) =>
    c.env.DB.prepare(
        "INSERT INTO transaction_guard SELECT count(*) FROM device_registrations WHERE registrationId=? AND expiresAt>=unixepoch('subsec')*1000 AND attempts<5"
    ).bind(row.registrationId);
export function registrationRoutes(app: App) {
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-registrations",
            input: R.RegistrationInput,
            output: R.RegistrationChallenge,
            status: 201,
            summary: "ESP32 requests an enrollment challenge; no identity trust yet",
        },
        async (c, input) => {
            await rateLimit(c.env, "registration:create:global", 120);
            const config = c.env as RegistrationEnv,
                site = S.Id.safeParse(config.REGISTRATION_SITE_ID),
                scope = S.Id.safeParse(config.REGISTRATION_SCOPE_ID);
            if (!site.success || !scope.success)
                throw new ApiError(503, "REGISTRATION_NOT_CONFIGURED");
            const siteId = site.data,
                scopeId = scope.data;
            const keyId = await hash(unb64(input.publicKey));
            if (
                await db(c.env)
                    .prepare("SELECT keyId FROM qr_keys WHERE keyId=?")
                    .bind(keyId)
                    .first()
            )
                throw new ApiError(409, "KEY_ALREADY_REGISTERED");
            const registrationId = crypto.randomUUID(),
                nonce = randomToken(),
                claimSecret = randomToken(),
                createdAt = Date.now(),
                expiresAt = createdAt + 600000;
            await db(c.env)
                .prepare(
                    "INSERT INTO device_registrations VALUES(?,?,?,?,?,?,?,?,?,'CHALLENGE',0,NULL,?,?)"
                )
                .bind(
                    registrationId,
                    siteId,
                    scopeId,
                    input.publicKey,
                    keyId,
                    input.hardwareTarget,
                    input.serial ?? null,
                    nonce,
                    await hash(claimSecret),
                    createdAt,
                    expiresAt
                )
                .run();
            return c.json({ registrationId, nonce, claimSecret, expiresAt }, 201);
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-registrations/{registrationId}/submit",
            input: R.RegistrationProof,
            output: R.RegistrationMeta,
            summary: "Proof of possession makes an ESP32 request visible for CMS approval",
        },
        async (c, input) => {
            const row = await access(c, input.claimSecret);
            await proof(c, row, input.proof, "SUBMIT");
            if (row.state === "PENDING") return c.json(meta(row));
            if (row.state !== "CHALLENGE") throw new ApiError(409, "REGISTRATION_STATE_CONFLICT");
            try {
                await db(c.env).batch([
                    alive(c, row),
                    c.env.DB.prepare(
                        "UPDATE device_registrations SET state='EXPIRED' WHERE keyId=? AND state='PENDING' AND expiresAt<?"
                    ).bind(row.keyId, Date.now()),
                    c.env.DB.prepare(
                        "INSERT INTO transaction_guard SELECT NOT EXISTS(SELECT 1 FROM qr_keys WHERE keyId=?)"
                    ).bind(row.keyId),
                    c.env.DB.prepare(
                        "UPDATE device_registrations SET state='PENDING' WHERE registrationId=? AND state='CHALLENGE'"
                    ).bind(row.registrationId),
                    changed(c.env),
                    c.env.DB.prepare("DELETE FROM transaction_guard"),
                ]);
            } catch (e) {
                if (/constraint|CONSTRAINT/.test(String(e)))
                    throw new ApiError(409, "REGISTRATION_CONFLICT");
                throw e;
            }
            return c.json(meta({ ...row, state: "PENDING" }));
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-registrations/{registrationId}/status",
            input: R.RegistrationAccess,
            output: R.RegistrationMeta,
            summary: "ESP32 privately polls approval state without receiving a credential",
        },
        async (c, input) => c.json(meta(await access(c, input.claimSecret)))
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/device-registrations",
            permission: "devices:read",
            query: R.RegistrationQuery,
            output: S.pageOf(R.RegistrationMeta),
            summary: "Pending device requests restricted by configured site and scope",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(R.RegistrationQuery, c.req.query());
            const state =
                "CASE WHEN state IN('CHALLENGE','PENDING','APPROVED') AND expiresAt<? THEN 'EXPIRED' ELSE state END";
            const rows = await db(c.env)
                .prepare(
                    `SELECT * FROM device_registrations WHERE siteId IN(SELECT value FROM json_each(?)) AND scopeId IN(SELECT value FROM json_each(?)) AND registrationId>? AND ${state}=? ORDER BY registrationId LIMIT ?`
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    Date.now(),
                    q.state,
                    q.limit + 1
                )
                .all<RegistrationRow>();
            return c.json({
                items: rows.results.slice(0, q.limit).map(meta),
                nextCursor:
                    rows.results.length > q.limit
                        ? rows.results[q.limit - 1]!.registrationId
                        : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/registration",
            permission: "devices:read",
            output: R.RegistrationMeta.nullable(),
            summary:
                "Read enrollment progress for one authorized device without changing legacy overview",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const row = await db(c.env)
                .prepare(
                    "SELECT * FROM device_registrations WHERE deviceId=? ORDER BY createdAt DESC,registrationId DESC LIMIT 1"
                )
                .bind(d.deviceId)
                .first<RegistrationRow>();
            return c.json(row ? meta(row) : null);
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/admin/device-registrations/{registrationId}/approve",
            permission: "pairings:write",
            input: R.RegistrationApproval,
            output: R.RegistrationMeta,
            summary:
                "CMS approves a proven request and creates the device without exposing its token",
        },
        async (c, input) => {
            const row = await registration(c),
                p = c.get("principal");
            grants(p, row.siteId, row.scopeId);
            if (!p.permissions.includes("devices:write")) throw new ApiError(403, "FORBIDDEN");
            const action = "registration:approve:" + row.registrationId,
                old = await replay(c.env, await intent(c, action, input));
            if (old) return replayResponse(old);
            if (row.expiresAt < Date.now()) throw new ApiError(410, "REGISTRATION_EXPIRED");
            if (row.state !== "PENDING") throw new ApiError(409, "REGISTRATION_STATE_CONFLICT");
            const deviceId = crypto.randomUUID().replaceAll("-", ""),
                response = meta({ ...row, state: "APPROVED", deviceId });
            return commit(c, action, input, response, [
                alive(c, row),
                c.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT count(*) FROM service_credentials WHERE credentialId=? AND revokedAt IS NULL AND 'pairings:write' IN(SELECT value FROM json_each(permissions)) AND 'devices:write' IN(SELECT value FROM json_each(permissions)) AND ? IN(SELECT value FROM json_each(sites)) AND ? IN(SELECT value FROM json_each(scopes))"
                ).bind(p.credentialId, row.siteId, row.scopeId),
                c.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT NOT EXISTS(SELECT 1 FROM qr_keys WHERE keyId=?)"
                ).bind(row.keyId),
                c.env.DB.prepare(
                    "INSERT INTO devices(deviceId,name,siteId,doorId,scopeId,qrBaseUrl,createdAt) VALUES(?,?,?,?,?,?,?)"
                ).bind(deviceId, input.name, row.siteId, deviceId, row.scopeId, "", Date.now()),
                c.env.DB.prepare(
                    "UPDATE device_registrations SET state='APPROVED',deviceId=? WHERE registrationId=? AND state='PENDING'"
                ).bind(deviceId, row.registrationId),
                changed(c.env),
                audit(c.env, p, c.get("actorId"), "DEVICE_REGISTRATION_APPROVED", {
                    deviceId,
                    siteId: row.siteId,
                    scopeId: row.scopeId,
                }),
            ]);
        }
    );
    endpoint(
        app,
        {
            method: "delete",
            path: "/api/admin/device-registrations/{registrationId}",
            permission: "pairings:write",
            output: S.Ok,
            summary: "CMS rejects a pending device request",
        },
        async (c) => {
            const row = await registration(c),
                p = c.get("principal");
            grants(p, row.siteId, row.scopeId);
            return commit(c, "registration:reject:" + row.registrationId, {}, { ok: true }, [
                c.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT count(*) FROM service_credentials WHERE credentialId=? AND revokedAt IS NULL AND 'pairings:write' IN(SELECT value FROM json_each(permissions)) AND ? IN(SELECT value FROM json_each(sites)) AND ? IN(SELECT value FROM json_each(scopes))"
                ).bind(p.credentialId, row.siteId, row.scopeId),
                c.env.DB.prepare(
                    "UPDATE device_registrations SET state='REJECTED' WHERE registrationId=? AND state='PENDING'"
                ).bind(row.registrationId),
                changed(c.env),
                audit(
                    c.env,
                    p,
                    c.get("actorId"),
                    "DEVICE_REGISTRATION_REJECTED",
                    undefined,
                    JSON.stringify({ registrationId: row.registrationId })
                ),
            ]);
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-registrations/{registrationId}/claim",
            input: R.RegistrationProof,
            output: S.PairingResult,
            status: 201,
            summary: "Approved ESP32 claims its credential once with its original key proof",
        },
        async (c, input) => {
            const row = await access(c, input.claimSecret);
            await proof(c, row, input.proof, "CLAIM");
            if (row.state !== "APPROVED" || !row.deviceId)
                throw new ApiError(409, "REGISTRATION_STATE_CONFLICT");
            const token = randomToken(),
                now = Date.now();
            try {
                await db(c.env).batch([
                    alive(c, row),
                    c.env.DB.prepare(
                        "INSERT INTO transaction_guard SELECT NOT EXISTS(SELECT 1 FROM audit WHERE deviceId=? AND action='CREDENTIAL_REVOKED')"
                    ).bind(row.deviceId),
                    c.env.DB.prepare(
                        "UPDATE device_registrations SET state='CLAIMED' WHERE registrationId=? AND state='APPROVED'"
                    ).bind(row.registrationId),
                    changed(c.env),
                    c.env.DB.prepare(
                        "UPDATE devices SET generation=1,credentialHash=?,pairedAt=? WHERE deviceId=? AND generation=0 AND credentialHash IS NULL AND deletedAt IS NULL"
                    ).bind(await hash(token), now, row.deviceId),
                    changed(c.env),
                    c.env.DB.prepare("INSERT INTO qr_keys VALUES(?,?,1,?,'ACTIVE',NULL,?)").bind(
                        row.keyId,
                        row.deviceId,
                        row.publicKey,
                        now
                    ),
                    audit(
                        c.env,
                        { clientId: "device" },
                        row.deviceId,
                        "DEVICE_REGISTRATION_CLAIMED",
                        { deviceId: row.deviceId, siteId: row.siteId, scopeId: row.scopeId }
                    ),
                    c.env.DB.prepare("DELETE FROM transaction_guard"),
                ]);
            } catch (e) {
                if (/constraint|CONSTRAINT/.test(String(e)))
                    throw new ApiError(409, "REGISTRATION_STATE_CONFLICT");
                throw e;
            }
            return c.json({ deviceId: row.deviceId, generation: 1, keyId: row.keyId, token }, 201);
        }
    );
}
