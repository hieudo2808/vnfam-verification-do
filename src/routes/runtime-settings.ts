import * as R from "../runtime-contracts";
import { type App, endpoint, commit, changed, intent, replay, replayResponse } from "../http";
import { ApiError, audit, db, device, grants, parse, type DeviceRow } from "../platform";
import { b64, bytes, unb64 } from "../crypto";
import { firmwarePrincipal } from "./devices";

type NetworkRow = { ssid: string; passwordCipher: string };
async function key(env: Env & { CONFIG_ENCRYPTION_KEY?: string }) {
    try {
        const raw = unb64(env.CONFIG_ENCRYPTION_KEY ?? "");
        if (raw.byteLength !== 32) throw new Error();
        return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    } catch {
        throw new ApiError(503, "CONFIG_ENCRYPTION_UNAVAILABLE");
    }
}
async function protectedIntent(
    env: Env & { CONFIG_ENCRYPTION_KEY?: string },
    input: import("zod").infer<typeof R.NetworkInput>
) {
    if (input.password === undefined) return input;
    await key(env);
    const hmac = await crypto.subtle.importKey(
        "raw",
        unb64(env.CONFIG_ENCRYPTION_KEY!),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    return {
        ...input,
        password: b64(
            new Uint8Array(
                await crypto.subtle.sign(
                    "HMAC",
                    hmac,
                    bytes(`WIFI_INTENT_V1|${input.ssid}|${input.password}`)
                )
            )
        ),
    };
}
async function timeSettings(env: Env) {
    const value = await db(env)
        .prepare("SELECT revision,server,timezone FROM time_settings WHERE singleton=1")
        .first<{ revision: number; server: string; timezone: string }>();
    if (!value) throw new ApiError(503, "STORAGE_UNAVAILABLE");
    return { ...value, protocol: "SNTP" as const };
}
async function network(env: Env, d: DeviceRow) {
    const row = await db(env)
        .prepare("SELECT ssid,passwordCipher FROM device_network_config WHERE deviceId=?")
        .bind(d.deviceId)
        .first<NetworkRow>();
    return {
        revision: d.configRevision,
        appliedRevision: d.appliedRevision,
        ssid: row?.ssid ?? null,
        passwordConfigured: !!row,
    };
}
export function runtimeSettingsRoutes(app: App) {
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/time-settings",
            permission: "devices:read",
            output: R.TimeSettings,
            summary: "Global automatic SNTP settings",
        },
        async (c) => c.json(await timeSettings(c.env))
    );
    endpoint(
        app,
        {
            method: "patch",
            path: "/api/admin/time-settings",
            permission: "policy:write",
            input: R.TimeSettingsInput,
            output: R.TimeSettings,
            summary: "Edit global SNTP server with optimistic revision",
        },
        async (c, input) => {
            if (c.get("principal").kind !== "OPERATOR") throw new ApiError(403, "FORBIDDEN");
            const old = await replay(c.env, await intent(c, "time:settings", input));
            if (old) return replayResponse(old);
            const current = await timeSettings(c.env);
            if (current.revision !== input.revision) throw new ApiError(409, "REVISION_CONFLICT");
            const timezone = input.timezone ?? current.timezone;
            return commit(
                c,
                "time:settings",
                input,
                { ...input, timezone, revision: input.revision + 1, protocol: "SNTP" },
                [
                    c.env.DB.prepare(
                        "UPDATE time_settings SET server=?,timezone=?,revision=revision+1 WHERE singleton=1 AND revision=?"
                    ).bind(input.server, timezone, input.revision),
                    changed(c.env),
                    audit(
                        c.env,
                        c.get("principal"),
                        c.get("actorId"),
                        "TIME_SETTINGS_UPDATED",
                        undefined,
                        JSON.stringify({
                            server: input.server,
                            timezone,
                            revision: input.revision + 1,
                        })
                    ),
                ]
            );
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/devices/{deviceId}/time-settings",
            output: R.TimeSettings,
            summary: "Own-device global SNTP settings; refresh automatically before sync",
        },
        async (c) => {
            await firmwarePrincipal(c);
            return c.json(await timeSettings(c.env));
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/devices/{deviceId}/runtime-settings",
            permission: "devices:read",
            output: R.RuntimeSettings,
            summary: "Visible network settings and reported device time, no password",
        },
        async (c) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const status = await db(c.env)
                .prepare(
                    "SELECT observedAt,runtimeConfigVersion,wifiSsid,timeReport FROM device_runtime_status WHERE deviceId=? AND generation=?"
                )
                .bind(d.deviceId, d.generation)
                .first<{
                    observedAt: number;
                    runtimeConfigVersion: 1 | null;
                    wifiSsid: string | null;
                    timeReport: string | null;
                }>();
            return c.json({
                network: await network(c.env, d),
                time: await timeSettings(c.env),
                status: status
                    ? {
                          observedAt: status.observedAt,
                          runtimeConfigVersion: status.runtimeConfigVersion,
                          wifiSsid: status.wifiSsid,
                          time: status.timeReport ? JSON.parse(status.timeReport) : null,
                      }
                    : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "patch",
            path: "/api/admin/devices/{deviceId}/network-config",
            permission: "devices:write",
            input: R.NetworkInput,
            output: R.NetworkConfig,
            summary: "Save Wi-Fi settings encrypted; does not apply or flash",
        },
        async (c, input) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const action = `network:${d.deviceId}`,
                safeIntent = await protectedIntent(c.env, input),
                old = await replay(c.env, await intent(c, action, safeIntent));
            if (old) return replayResponse(old);
            if (input.revision !== d.configRevision) throw new ApiError(409, "REVISION_CONFLICT");
            const previous = await db(c.env)
                .prepare("SELECT ssid,passwordCipher FROM device_network_config WHERE deviceId=?")
                .bind(d.deviceId)
                .first<NetworkRow>();
            if (input.password === undefined && (!previous || previous.ssid !== input.ssid))
                throw new ApiError(422, "WIFI_PASSWORD_REQUIRED");
            let cipher = previous?.passwordCipher ?? "";
            if (input.password !== undefined) {
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const encrypted = await crypto.subtle.encrypt(
                    {
                        name: "AES-GCM",
                        iv,
                        additionalData: bytes(`WIFI_V1|${d.deviceId}|${input.ssid}`),
                    },
                    await key(c.env),
                    bytes(input.password)
                );
                cipher = b64(iv) + "." + b64(new Uint8Array(encrypted));
            }
            return commit(
                c,
                action,
                safeIntent,
                {
                    revision: input.revision + 1,
                    appliedRevision: d.appliedRevision,
                    ssid: input.ssid,
                    passwordConfigured: true,
                },
                [
                    c.env.DB.prepare(
                        "UPDATE devices SET configRevision=configRevision+1 WHERE deviceId=? AND configRevision=? AND siteId=? AND scopeId=?"
                    ).bind(d.deviceId, input.revision, d.siteId, d.scopeId),
                    changed(c.env),
                    c.env.DB.prepare(
                        "INSERT INTO device_network_config VALUES(?,?,?) ON CONFLICT(deviceId) DO UPDATE SET ssid=excluded.ssid,passwordCipher=excluded.passwordCipher"
                    ).bind(d.deviceId, input.ssid, cipher),
                    audit(c.env, c.get("principal"), c.get("actorId"), "NETWORK_CONFIG_SAVED", d),
                ]
            );
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/devices/{deviceId}/network-config",
            query: R.NetworkDownloadQuery,
            output: R.NetworkDownload,
            summary: "Own authenticated device retrieves Wi-Fi only for its apply operation",
        },
        async (c) => {
            const d = await firmwarePrincipal(c),
                q = parse(R.NetworkDownloadQuery, c.req.query());
            const row = await db(c.env)
                .prepare(
                    "SELECT n.ssid,n.passwordCipher,d.configRevision FROM devices d JOIN device_network_config n ON n.deviceId=d.deviceId JOIN operations o ON o.deviceId=d.deviceId AND o.generation=d.generation WHERE d.deviceId=? AND d.generation=? AND d.credentialHash=? AND o.operationId=? AND o.action='APPLY_CONFIG' AND o.state IN('SENT','ACKNOWLEDGED','RUNNING','UNKNOWN') AND json_extract(o.payload,'$.runtimeConfigVersion')=1 AND json_extract(o.payload,'$.revision')=d.configRevision AND json_extract(o.payload,'$.wifiSsid')=n.ssid"
                )
                .bind(d.deviceId, d.generation, d.credentialHash, q.operationId)
                .first<NetworkRow & { configRevision: number }>();
            if (!row) throw new ApiError(409, "OPERATION_INVALID");
            const [iv, cipher] = row.passwordCipher.split(".");
            try {
                const decrypted = await crypto.subtle.decrypt(
                    {
                        name: "AES-GCM",
                        iv: unb64(iv!),
                        additionalData: bytes(`WIFI_V1|${d.deviceId}|${row.ssid}`),
                    },
                    await key(c.env),
                    unb64(cipher!)
                );
                return c.json({
                    revision: row.configRevision,
                    ssid: row.ssid,
                    password: new TextDecoder().decode(decrypted),
                });
            } catch {
                throw new ApiError(503, "CONFIG_DECRYPT_FAILED");
            }
        }
    );
}
