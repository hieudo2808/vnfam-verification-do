import * as S from "../contracts";
import { type App, endpoint, commit, changed, intent, replay, replayResponse } from "../http";
import { ApiError, audit, db, device, grants, publicDevice, parse, rateLimit } from "../platform";
import { hash, randomToken, unb64, verifyDeviceSignature, pairingBytes } from "../crypto";

export function registryRoutes(app: App) {
    endpoint(
        app,
        {
            method: "post",
            path: "/api/admin/devices",
            permission: "devices:write",
            input: S.DeviceInput,
            output: S.Device,
            status: 201,
            summary: "Register device (REQ-TRUST)",
        },
        async (c, input) => {
            grants(c.get("principal"), input.siteId, input.scopeId);
            const createdAt = Date.now();
            const response = {
                ...input,
                checkInEnabled: true,
                generation: 0,
                pairedAt: null,
                confirmedAt: null,
                configRevision: 1,
                appliedRevision: 0,
                firmwareTarget: null,
                bootId: null,
                hardwareTarget: null,
                firmwareVersion: null,
                buildId: null,
                otaSlotBytes: null,
                capabilities: [],
                lastSeenAt: null,
                createdAt,
            };
            return commit(
                c,
                "device:create",
                input,
                response,
                [
                    c.env.DB.prepare(
                        "INSERT INTO devices(deviceId,name,siteId,doorId,scopeId,qrBaseUrl,createdAt) VALUES(?,?,?,?,?,?,?)"
                    ).bind(
                        input.deviceId,
                        input.name,
                        input.siteId,
                        input.doorId,
                        input.scopeId,
                        input.qrBaseUrl,
                        createdAt
                    ),
                    audit(c.env, c.get("principal"), c.get("actorId"), "DEVICE_CREATED", input),
                ],
                201
            );
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices",
            permission: "devices:read",
            query: S.PageQuery,
            output: S.pageOf(S.Device),
            summary: "List authorized device snapshots",
        },
        async (c) => {
            const p = c.get("principal"),
                q = parse(S.PageQuery, c.req.query());
            const rows = await db(c.env)
                .prepare(
                    "SELECT * FROM devices WHERE deletedAt IS NULL AND siteId IN (SELECT value FROM json_each(?)) AND scopeId IN (SELECT value FROM json_each(?)) AND deviceId>? ORDER BY deviceId LIMIT ?"
                )
                .bind(
                    JSON.stringify(p.sites),
                    JSON.stringify(p.scopes),
                    q.cursor ?? "",
                    q.limit + 1
                )
                .all<import("../platform").DeviceRow>();
            return c.json({
                items: rows.results.slice(0, q.limit).map(publicDevice),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.deviceId : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}",
            permission: "devices:read",
            output: S.Device,
            summary: "Device detail and live liveness",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            return c.json({
                ...publicDevice(d),
                online: await c.env.DEVICES.getByName(d.deviceId).isOnline(),
            });
        }
    );
    endpoint(
        app,
        {
            method: "delete",
            path: "/api/admin/devices/{deviceId}",
            permission: "devices:write",
            output: S.Ok,
            summary: "Delete from active registry, revoke access and preserve history",
        },
        async (c) => {
            const p = c.get("principal"),
                d = await device(c.env, c.req.param("deviceId")!, true);
            if (!p.permissions.includes("credentials:revoke")) throw new ApiError(403, "FORBIDDEN");
            grants(p, d.siteId, d.scopeId);
            const i = await intent(c, `device:delete:${d.deviceId}`, {}),
                old = await replay(c.env, i);
            if (old) return replayResponse(old);
            if (d.deletedAt !== null) throw new ApiError(404, "DEVICE_NOT_FOUND");
            const stub = c.env.DEVICES.getByName(d.deviceId),
                invalidation = await stub.prepareInvalidation(d.deviceId);
            const result = await commit(c, i.action, {}, { ok: true }, [
                c.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT unixepoch('subsec')*1000 <= ?"
                ).bind(invalidation.expiresAt),
                c.env.DB.prepare(
                    "UPDATE devices SET deletedAt=?,credentialHash=NULL,checkInEnabled=0 WHERE deviceId=? AND generation=? AND siteId=? AND scopeId=? AND deletedAt IS NULL"
                ).bind(Date.now(), d.deviceId, d.generation, d.siteId, d.scopeId),
                changed(c.env),
                c.env.DB.prepare("UPDATE qr_keys SET state='REVOKED' WHERE deviceId=?").bind(
                    d.deviceId
                ),
                c.env.DB.prepare(
                    "UPDATE pairings SET state='CANCELLED' WHERE deviceId=? AND state='PENDING'"
                ).bind(d.deviceId),
                c.env.DB.prepare("DELETE FROM device_network_config WHERE deviceId=?").bind(
                    d.deviceId
                ),
                audit(c.env, p, c.get("actorId"), "DEVICE_DELETED", d),
            ]);
            await stub.finishInvalidation(invalidation.intentId);
            return result;
        }
    );
    endpoint(
        app,
        {
            method: "patch",
            path: "/api/admin/devices/{deviceId}",
            permission: "devices:write",
            input: S.DevicePatch,
            output: S.Device,
            summary: "Edit device acceptance/profile",
        },
        async (c, input) => {
            const d = await device(c.env, c.req.param("deviceId")!),
                p = c.get("principal");
            grants(p, d.siteId, d.scopeId);
            grants(p, input.siteId ?? d.siteId, d.scopeId);
            return commit(
                c,
                `device:patch:${d.deviceId}`,
                input,
                { ...publicDevice(d), ...input },
                [
                    c.env.DB.prepare(
                        "UPDATE devices SET name=?,siteId=?,doorId=?,checkInEnabled=? WHERE deviceId=? AND siteId=? AND scopeId=? AND name=? AND doorId=? AND checkInEnabled=?"
                    ).bind(
                        input.name ?? d.name,
                        input.siteId ?? d.siteId,
                        input.doorId ?? d.doorId,
                        input.checkInEnabled === undefined
                            ? d.checkInEnabled
                            : Number(input.checkInEnabled),
                        d.deviceId,
                        d.siteId,
                        d.scopeId,
                        d.name,
                        d.doorId,
                        d.checkInEnabled
                    ),
                    changed(c.env),
                    audit(c.env, p, c.get("actorId"), "DEVICE_UPDATED", d),
                ]
            );
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/config",
            permission: "devices:read",
            output: S.Config,
            summary: "Read desired versus applied config",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            return c.json({
                revision: d.configRevision,
                scopeId: d.scopeId,
                qrBaseUrl: d.qrBaseUrl,
                appliedRevision: d.appliedRevision,
            });
        }
    );
    endpoint(
        app,
        {
            method: "patch",
            path: "/api/admin/devices/{deviceId}/config",
            permission: "devices:write",
            input: S.ConfigInput,
            output: S.Config,
            summary: "Optimistic config revision edit",
        },
        async (c, input) => {
            const d = await device(c.env, c.req.param("deviceId")!),
                p = c.get("principal");
            grants(p, d.siteId, d.scopeId);
            grants(p, d.siteId, input.scopeId);
            const i = await intent(c, `config:${d.deviceId}`, input),
                old = await replay(c.env, i);
            if (old) return replayResponse(old);
            if (input.revision !== d.configRevision) throw new ApiError(409, "REVISION_CONFLICT");
            return commit(
                c,
                i.action,
                input,
                { ...input, revision: input.revision + 1, appliedRevision: d.appliedRevision },
                [
                    c.env.DB.prepare(
                        "UPDATE devices SET scopeId=?,qrBaseUrl=?,configRevision=configRevision+1 WHERE deviceId=? AND configRevision=? AND siteId=?"
                    ).bind(input.scopeId, input.qrBaseUrl, d.deviceId, input.revision, d.siteId),
                    changed(c.env),
                    audit(c.env, p, c.get("actorId"), "CONFIG_DESIRED", d),
                ]
            );
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/admin/device-pairings",
            permission: "pairings:write",
            input: S.PairingInput,
            output: S.Pairing,
            status: 201,
            summary: "Create one-time commissioning session",
        },
        async (c, input) => {
            const d = await device(c.env, input.deviceId),
                p = c.get("principal");
            grants(p, d.siteId, d.scopeId);
            const i = await intent(c, "pairing:create", input),
                old = await replay(c.env, i);
            if (old) return replayResponse(old);
            if (d.generation > 0 && !input.replaceIdentity)
                throw new ApiError(409, "REPLACE_IDENTITY_REQUIRED");
            const code = randomToken(),
                nonce = randomToken(),
                pairingId = crypto.randomUUID(),
                expiresAt = Date.now() + 600000;
            const response = {
                pairingId,
                deviceId: d.deviceId,
                nonce,
                expiresAt,
                state: "PENDING" as const,
            };
            return commit(
                c,
                i.action,
                input,
                { ...response, code },
                [
                    c.env.DB.prepare(
                        "INSERT INTO transaction_guard SELECT count(*) FROM devices WHERE deviceId=? AND generation=? AND siteId=? AND scopeId=? AND deletedAt IS NULL"
                    ).bind(d.deviceId, d.generation, d.siteId, d.scopeId),
                    c.env.DB.prepare(
                        "UPDATE pairings SET state='CANCELLED' WHERE deviceId=? AND state='PENDING'"
                    ).bind(d.deviceId),
                    c.env.DB.prepare(
                        "INSERT INTO pairings(pairingId,deviceId,codeHash,nonce,generation,expiresAt,state,createdAt) VALUES(?,?,?,?,?,?,'PENDING',?)"
                    ).bind(
                        pairingId,
                        d.deviceId,
                        await hash(code),
                        nonce,
                        d.generation + 1,
                        expiresAt,
                        Date.now()
                    ),
                    audit(c.env, p, c.get("actorId"), "PAIRING_CREATED", d),
                ],
                201,
                response
            );
        }
    );
    endpoint(
        app,
        {
            method: "delete",
            path: "/api/admin/device-pairings/{pairingId}",
            permission: "pairings:write",
            output: S.Ok,
            summary: "Cancel pairing",
        },
        async (c) => {
            const row = await db(c.env)
                .prepare("SELECT deviceId FROM pairings WHERE pairingId=?")
                .bind(c.req.param("pairingId")!)
                .first<{ deviceId: string }>();
            if (!row) throw new ApiError(404, "PAIRING_NOT_FOUND");
            const d = await device(c.env, row.deviceId);
            grants(c.get("principal"), d.siteId, d.scopeId);
            return commit(c, `pairing:cancel:${c.req.param("pairingId")}`, {}, { ok: true }, [
                c.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT count(*) FROM devices WHERE deviceId=? AND siteId=? AND scopeId=?"
                ).bind(d.deviceId, d.siteId, d.scopeId),
                c.env.DB.prepare(
                    "UPDATE pairings SET state='CANCELLED' WHERE pairingId=? AND state='PENDING'"
                ).bind(c.req.param("pairingId")!),
                audit(c.env, c.get("principal"), c.get("actorId"), "PAIRING_CANCELLED", d),
            ]);
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/device-pairings/complete",
            input: S.PairingComplete,
            output: S.PairingResult,
            status: 201,
            summary: "One-time pairing proof; response cannot be replayed",
        },
        async (c, input) => {
            await rateLimit(c.env, "pairing:global", 300);
            const p = await db(c.env)
                .prepare("SELECT * FROM pairings WHERE pairingId=?")
                .bind(input.pairingId)
                .first<{
                    pairingId: string;
                    deviceId: string;
                    codeHash: string;
                    nonce: string;
                    generation: number;
                    expiresAt: number;
                    attempts: number;
                    state: string;
                }>();
            if (!p) throw new ApiError(422, "PAIRING_INVALID");
            if (p.state !== "PENDING")
                throw new ApiError(
                    409,
                    p.state === "LOCKED" ? "PAIRING_LOCKED" : "PAIRING_CONSUMED"
                );
            if (p.expiresAt < Date.now()) throw new ApiError(410, "PAIRING_EXPIRED");
            const keyId = await hash(unb64(input.publicKey));
            if (
                p.codeHash !== (await hash(input.code)) ||
                !(await verifyDeviceSignature(input.publicKey, input.proof, pairingBytes(p, keyId)))
            ) {
                await db(c.env)
                    .prepare(
                        "UPDATE pairings SET attempts=attempts+1,state=CASE WHEN attempts+1>=5 THEN 'LOCKED' ELSE state END WHERE pairingId=? AND state='PENDING'"
                    )
                    .bind(p.pairingId)
                    .run();
                throw new ApiError(422, "PROOF_INVALID");
            }
            const token = randomToken(),
                now = Date.now();
            const stub = c.env.DEVICES.getByName(p.deviceId);
            const invalidation = await stub.prepareInvalidation(p.deviceId);
            try {
                await db(c.env).batch([
                    c.env.DB.prepare(
                        "INSERT INTO transaction_guard SELECT unixepoch('subsec')*1000 <= ?"
                    ).bind(invalidation.expiresAt),
                    c.env.DB.prepare(
                        "UPDATE pairings SET state='CONSUMED' WHERE pairingId=? AND state='PENDING' AND attempts<5 AND expiresAt>=?"
                    ).bind(p.pairingId, now),
                    changed(c.env),
                    c.env.DB.prepare(
                        "UPDATE qr_keys SET state='REVOKED' WHERE deviceId=? AND state!='REVOKED'"
                    ).bind(p.deviceId),
                    c.env.DB.prepare(
                        "UPDATE devices SET generation=?,credentialHash=?,pairedAt=?,confirmedAt=NULL,appliedRevision=0 WHERE deviceId=? AND generation=? AND deletedAt IS NULL"
                    ).bind(p.generation, await hash(token), now, p.deviceId, p.generation - 1),
                    changed(c.env),
                    c.env.DB.prepare(
                        `INSERT INTO qr_keys VALUES(?,?,?,?,'ACTIVE',NULL,?)
                         ON CONFLICT(keyId) DO UPDATE SET generation=excluded.generation,state='ACTIVE',operationId=NULL
                         WHERE qr_keys.deviceId=excluded.deviceId AND qr_keys.publicKey=excluded.publicKey`
                    ).bind(
                        keyId,
                        p.deviceId,
                        p.generation,
                        input.publicKey,
                        now
                    ),
                    changed(c.env),
                    audit(
                        c.env,
                        { clientId: "device" },
                        p.deviceId,
                        "PAIRING_COMPLETED",
                        await device(c.env, p.deviceId)
                    ),
                    c.env.DB.prepare("DELETE FROM transaction_guard"),
                ]);
            } catch (e) {
                if (/constraint|CONSTRAINT/.test(String(e)))
                    throw new ApiError(409, "PAIRING_CONSUMED");
                throw e;
            }
            await stub.finishInvalidation(invalidation.intentId);
            return c.json({ deviceId: p.deviceId, generation: p.generation, keyId, token }, 201);
        }
    );
    endpoint(
        app,
        {
            method: "delete",
            path: "/api/admin/devices/{deviceId}/credential",
            permission: "credentials:revoke",
            output: S.Ok,
            summary: "Revoke device management credential",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const stub = c.env.DEVICES.getByName(d.deviceId);
            const invalidation = await stub.prepareInvalidation(d.deviceId);
            const result = await commit(c, `credential:revoke:${d.deviceId}`, {}, { ok: true }, [
                c.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT unixepoch('subsec')*1000 <= ?"
                ).bind(invalidation.expiresAt),
                c.env.DB.prepare(
                    "UPDATE devices SET credentialHash=NULL WHERE deviceId=? AND siteId=? AND scopeId=?"
                ).bind(d.deviceId, d.siteId, d.scopeId),
                changed(c.env),
                audit(c.env, c.get("principal"), c.get("actorId"), "CREDENTIAL_REVOKED", d),
            ]);
            await stub.finishInvalidation(invalidation.intentId);
            return result;
        }
    );
    endpoint(
        app,
        {
            method: "post",
            path: "/api/admin/devices/{deviceId}/key-revocations",
            permission: "keys:revoke",
            input: S.RevokeKeyInput,
            output: S.Ok,
            summary: "Immediately revoke QR signing key",
        },
        async (c, input) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            return commit(c, `key:revoke:${d.deviceId}`, input, { ok: true }, [
                c.env.DB.prepare(
                    "UPDATE qr_keys SET state='REVOKED' WHERE keyId=? AND deviceId=? AND EXISTS(SELECT 1 FROM devices WHERE deviceId=? AND siteId=? AND scopeId=?)"
                ).bind(input.keyId, d.deviceId, d.deviceId, d.siteId, d.scopeId),
                changed(c.env),
                audit(c.env, c.get("principal"), c.get("actorId"), "QR_KEY_REVOKED", d),
            ]);
        }
    );
}
