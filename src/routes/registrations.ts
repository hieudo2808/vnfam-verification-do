import { z } from "@hono/zod-openapi";
import * as R from "../registration-contracts";
import * as S from "../contracts";
import { type App, endpoint, changed } from "../http";
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
    state: z.infer<typeof R.RegistrationState>;
    attempts: number;
    deviceId: string | null;
    createdAt: number;
    expiresAt: number;
};
type RegistrationEnv = Env & { REGISTRATION_SITE_ID?: string; REGISTRATION_SCOPE_ID?: string };
function sameBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false;
    let different = 0;
    for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
    return different === 0;
}
function meta(row: RegistrationRow) {
    return R.RegistrationMeta.parse({
        ...Object.fromEntries(
            Object.keys(R.RegistrationMeta.shape).map((key) => [
                key,
                row[key as keyof RegistrationRow],
            ])
        ),
        state: row.state === "CHALLENGE" && row.expiresAt < Date.now() ? "EXPIRED" : row.state,
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
export function registrationRoutes(app: App) {
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-registrations",
            input: R.RegistrationInput,
            output: R.RegistrationChallenge,
            status: 201,
            summary: "Store the public key and issue a private enrollment challenge",
        },
        async (c, input) => {
            await rateLimit(c.env, "registration:create:global", 120);
            const config = c.env as RegistrationEnv,
                site = S.Id.safeParse(config.REGISTRATION_SITE_ID),
                scope = S.Id.safeParse(config.REGISTRATION_SCOPE_ID);
            if (!site.success || !scope.success)
                throw new ApiError(503, "REGISTRATION_NOT_CONFIGURED");
            const siteId = site.data,
                scopeId = scope.data,
                keyId = await hash(unb64(input.publicKey));
            if (
                await db(c.env)
                    .prepare("SELECT keyId FROM qr_keys WHERE keyId=?")
                    .bind(keyId)
                    .first()
            )
                throw new ApiError(409, "KEY_ALREADY_REGISTERED");
            const registrationId = crypto.randomUUID(),
                nonce = randomToken(),
                createdAt = Date.now(),
                expiresAt = createdAt + 600000;
            await db(c.env)
                .prepare(
                    "INSERT INTO device_registrations VALUES(?,?,?,?,?,?,?,?,'CHALLENGE',0,NULL,?,?)"
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
                    createdAt,
                    expiresAt
                )
                .run();
            return c.json({ registrationId, nonce, expiresAt }, 201);
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-registrations/{registrationId}/complete",
            input: R.RegistrationProof,
            output: S.PairingResult,
            status: 201,
            summary: "Verify key possession, register the device and issue its credential once",
        },
        async (c, input) => {
            await rateLimit(c.env, "registration:complete:global", 1200);
            const row = await registration(c);
            if (!sameBytes(unb64(input.nonce), unb64(row.nonce)))
                throw new ApiError(401, "UNAUTHORIZED");
            await rateLimit(c.env, "registration:" + row.registrationId, 30);
            if (row.expiresAt < Date.now()) throw new ApiError(410, "REGISTRATION_EXPIRED");
            if (row.state === "LOCKED") throw new ApiError(409, "REGISTRATION_LOCKED");
            if (row.state !== "CHALLENGE") throw new ApiError(409, "REGISTRATION_STATE_CONFLICT");
            if (!(await verifyDeviceSignature(row.publicKey, input.proof, R.registrationBytes(row)))) {
                await db(c.env)
                    .prepare(
                        "UPDATE device_registrations SET attempts=attempts+1,state=CASE WHEN attempts+1>=5 THEN 'LOCKED' ELSE state END WHERE registrationId=? AND state='CHALLENGE'"
                    )
                    .bind(row.registrationId)
                    .run();
                throw new ApiError(422, "PROOF_INVALID");
            }
            const deviceId = crypto.randomUUID().replaceAll("-", ""),
                token = randomToken(),
                now = Date.now();
            try {
                await db(c.env).batch([
                    c.env.DB.prepare(
                        "INSERT INTO transaction_guard SELECT count(*) FROM device_registrations WHERE registrationId=? AND state='CHALLENGE' AND expiresAt>=unixepoch('subsec')*1000 AND attempts<5"
                    ).bind(row.registrationId),
                    c.env.DB.prepare(
                        "INSERT INTO devices(deviceId,name,siteId,doorId,scopeId,qrBaseUrl,generation,credentialHash,pairedAt,createdAt) VALUES(?,?,?,?,?,'',1,?,?,?)"
                    ).bind(
                        deviceId,
                        row.serial?.trim() || row.hardwareTarget,
                        row.siteId,
                        deviceId,
                        row.scopeId,
                        await hash(token),
                        now,
                        now
                    ),
                    c.env.DB.prepare("INSERT INTO qr_keys VALUES(?,?,1,?,'ACTIVE',NULL,?)").bind(
                        row.keyId,
                        deviceId,
                        row.publicKey,
                        now
                    ),
                    c.env.DB.prepare(
                        "UPDATE device_registrations SET state='COMPLETED',deviceId=? WHERE registrationId=? AND state='CHALLENGE'"
                    ).bind(deviceId, row.registrationId),
                    changed(c.env),
                    audit(c.env, { clientId: "device" }, deviceId, "DEVICE_REGISTRATION_COMPLETED", {
                        deviceId,
                        siteId: row.siteId,
                        scopeId: row.scopeId,
                    }),
                    c.env.DB.prepare("DELETE FROM transaction_guard"),
                ]);
            } catch (e) {
                if (/constraint|CONSTRAINT/.test(String(e)))
                    throw new ApiError(409, "REGISTRATION_STATE_CONFLICT");
                throw e;
            }
            return c.json({ deviceId, generation: 1, keyId: row.keyId, token }, 201);
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/device-registrations",
            permission: "devices:read",
            query: R.RegistrationQuery,
            output: S.pageOf(R.RegistrationMeta),
            summary: "Monitor device registrations restricted by configured site and scope",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(R.RegistrationQuery, c.req.query());
            const state = "CASE WHEN state='CHALLENGE' AND expiresAt<? THEN 'EXPIRED' ELSE state END";
            const rows = await db(c.env)
                .prepare(
                    `SELECT * FROM device_registrations WHERE siteId IN(SELECT value FROM json_each(?)) AND scopeId IN(SELECT value FROM json_each(?)) AND registrationId>? AND (?='ALL' OR ${state}=?) ORDER BY registrationId LIMIT ?`
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    q.state,
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
            summary: "Read registration details for one authorized device",
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
}
