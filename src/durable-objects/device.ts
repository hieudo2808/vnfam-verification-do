import { DurableObject } from "cloudflare:workers";
import { valid, gt } from "semver";
import type { z } from "@hono/zod-openapi";
import * as S from "../contracts";
import {
    ApiError,
    db,
    device,
    deviceAuth,
    bearer,
    audit,
    parse,
    grants,
    type DeviceRow,
    type OperationRow,
    type Principal,
} from "../platform";
import { hash, canonical, randomToken, unb64, verifyDeviceSignature, rotationBytes } from "../crypto";
import { changed, claim, replay, type Intent } from "../http";
import { advance, resultState } from "../operations";

type Session = {
    deviceId: string;
    sessionId: string;
    generation: number;
    bootId: string | null;
    lastSeenAt: number;
    bucket: number;
    count: number;
    epoch: number;
};
type RecoveryIntent = { operationId: string; deviceId: string; phase: string; due: number };
export class DeviceDO extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS intents(operationId TEXT PRIMARY KEY,deviceId TEXT NOT NULL,phase TEXT NOT NULL,due INTEGER NOT NULL)"
        );
        ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS closures(intentId TEXT PRIMARY KEY,deviceId TEXT NOT NULL,generation INTEGER NOT NULL,expiresAt INTEGER NOT NULL)"
        );
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
    private attachment(ws: WebSocket): Session {
        return ws.deserializeAttachment() as Session;
    }
    private socket(d: DeviceRow): WebSocket | undefined {
        return this.ctx.getWebSockets().find((ws) => {
            const a = this.attachment(ws);
            const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
            return (
                ws.readyState === 1 &&
                a.deviceId === d.deviceId &&
                a.generation === d.generation &&
                a.sessionId === d.currentSession &&
                a.bootId !== null &&
                Math.max(a.lastSeenAt, ping) >= Date.now() - 90000
            );
        });
    }
    private send(ws: WebSocket, message: z.infer<typeof S.ServerMessage>) {
        ws.send(JSON.stringify(S.ServerMessage.parse(message)));
    }
    private ack(ws: WebSocket, eventId: string) {
        this.send(ws, {
            version: 1,
            type: "EVENT_ACK",
            eventId: crypto.randomUUID(),
            payload: { eventId },
        });
    }
    private async schedule(due: number) {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || due < current)
            await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, due));
    }
    async isOnline(): Promise<boolean> {
        const a = this.ctx.getWebSockets().map((ws) => this.attachment(ws))[0];
        if (!a) return false;
        const d = await device(this.env, a.deviceId, true);
        return !!d.credentialHash && !!this.socket(d);
    }
    async observeConnection(deviceId: string) {
        const d = await device(this.env, deviceId),
            state = d.credentialHash && this.socket(d) ? "ONLINE" : "OFFLINE",
            observedAt = Date.now();
        await db(this.env)
            .prepare(
                "INSERT INTO device_presence SELECT deviceId,generation,currentSession,?,? FROM devices WHERE deviceId=? AND generation=? AND currentSession IS ? ON CONFLICT(deviceId) DO UPDATE SET generation=excluded.generation,sessionId=excluded.sessionId,state=excluded.state,observedAt=excluded.observedAt WHERE excluded.observedAt>=device_presence.observedAt"
            )
            .bind(state, observedAt, d.deviceId, d.generation, d.currentSession)
            .run();
        return { state, observedAt };
    }
    async fetch(request: Request): Promise<Response> {
        const deviceId = parse(S.Id, new URL(request.url).pathname.split("/")[3]);
        const d = await deviceAuth(
            this.env,
            deviceId,
            bearer(request.headers.get("authorization") ?? undefined)
        );
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
            throw new ApiError(422, "WEBSOCKET_REQUIRED");
        const sessionId = crypto.randomUUID();
        const connected = await db(this.env)
            .prepare(
                "UPDATE devices SET currentSession=?,sessionEpoch=sessionEpoch+1 WHERE deviceId=? AND generation=? AND credentialHash=? RETURNING sessionEpoch"
            )
            .bind(sessionId, d.deviceId, d.generation, d.credentialHash)
            .first<{ sessionEpoch: number }>();
        if (!connected) throw new ApiError(401, "UNAUTHORIZED");
        const pair = new WebSocketPair(),
            client = pair[0],
            server = pair[1];
        for (const old of this.ctx.getWebSockets())
            if (this.attachment(old).epoch < connected.sessionEpoch)
                old.close(4001, "SESSION_REPLACED");
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
            deviceId,
            sessionId,
            generation: d.generation,
            bootId: null,
            lastSeenAt: Date.now(),
            bucket: 0,
            count: 0,
            epoch: connected.sessionEpoch,
        } satisfies Session);
        this.send(server, {
            version: 1,
            type: "WELCOME",
            eventId: crypto.randomUUID(),
            payload: { sessionId, generation: d.generation, serverTimeMs: Date.now() },
        });
        return new Response(null, { status: 101, webSocket: client });
    }
    async prepareInvalidation(deviceId: string) {
        const d = await device(this.env, deviceId),
            intentId = crypto.randomUUID(),
            expiresAt = Date.now() + 60000;
        this.ctx.storage.sql.exec(
            "INSERT INTO closures VALUES(?,?,?,?)",
            intentId,
            deviceId,
            d.generation,
            expiresAt
        );
        await this.schedule(Date.now() + 1000);
        return { intentId, expiresAt };
    }
    async reconcile() {
        for (const row of this.ctx.storage.sql
            .exec<{ intentId: string; deviceId: string; generation: number; expiresAt: number }>(
                "SELECT * FROM closures"
            )
            .toArray()) {
            const d = await device(this.env, row.deviceId, true);
            for (const ws of this.ctx.getWebSockets()) {
                const a = this.attachment(ws);
                if (
                    !d.credentialHash ||
                    a.generation !== d.generation ||
                    a.sessionId !== d.currentSession
                )
                    ws.close(4001, "AUTHORITY_REVOKED");
            }
            if (
                !d.credentialHash ||
                d.generation !== row.generation ||
                Date.now() > row.expiresAt + 2000
            )
                this.ctx.storage.sql.exec("DELETE FROM closures WHERE intentId=?", row.intentId);
        }
    }
    async finishInvalidation(intentId: string) {
        await this.reconcile();
        this.ctx.storage.sql.exec("DELETE FROM closures WHERE intentId=?", intentId);
    }
    private async authority(ws: WebSocket) {
        const a = this.attachment(ws),
            d = await device(this.env, a.deviceId, true);
        if (
            !d.credentialHash ||
            a.generation !== d.generation ||
            a.sessionId !== d.currentSession
        ) {
            ws.close(4001, "AUTHORITY_REVOKED");
            throw new ApiError(401, "UNAUTHORIZED");
        }
        return { a, d };
    }
    private authorityGuard(d: DeviceRow, sessionId: string) {
        return this.env.DB.prepare(
            "INSERT INTO transaction_guard SELECT count(*) FROM devices WHERE deviceId=? AND generation=? AND credentialHash IS NOT NULL AND currentSession=?"
        ).bind(d.deviceId, d.generation, sessionId);
    }
    private serviceGuard(p: Principal, d: DeviceRow): D1PreparedStatement[] {
        return p.kind === "DEVICE"
            ? []
            : [
                  this.env.DB.prepare(
                      `INSERT INTO transaction_guard SELECT count(*) FROM service_credentials s JOIN devices d ON d.deviceId=?
            WHERE s.credentialId=? AND s.revokedAt IS NULL AND s.kind!='MINIGAME' AND 'commands:write' IN(SELECT value FROM json_each(s.permissions))
            AND d.siteId IN(SELECT value FROM json_each(s.sites)) AND d.scopeId IN(SELECT value FROM json_each(s.scopes))`
                  ).bind(d.deviceId, p.credentialId),
              ];
    }
    private targetGuard(
        d: DeviceRow,
        action: string,
        payload: Record<string, unknown>
    ): D1PreparedStatement[] {
        if (action === "APPLY_CONFIG")
            return [
                this.env.DB.prepare(
                    "INSERT INTO transaction_guard SELECT count(*) FROM devices WHERE deviceId=? AND configRevision=?"
                ).bind(d.deviceId, payload.revision),
            ];
        return action !== "UPGRADE_FIRMWARE"
            ? []
            : [
                  this.env.DB.prepare(
                      `INSERT INTO transaction_guard SELECT count(*) FROM firmware_releases r JOIN publisher_keys p ON p.keyId=r.publisherKeyId JOIN devices d ON d.deviceId=?
            WHERE r.releaseId=? AND d.firmwareTarget=r.releaseId AND r.state='APPROVED' AND r.verified=1 AND p.revokedAt IS NULL
            AND d.hardwareTarget=r.hardwareTarget AND d.otaSlotBytes>=r.size AND d.firmwareVersion=? AND d.bootId=?`
                  ).bind(d.deviceId, String(payload.releaseId), d.firmwareVersion, d.bootId),
              ];
    }
    async startOperation(
        deviceId: string,
        action: z.infer<typeof S.Action>,
        i: Intent,
        principal: Principal,
        actorId: string,
        expectedReleaseId?: string
    ) {
        try {
            const old = await replay(this.env, i);
            if (old)
                return { operation: parse(S.Operation, JSON.parse(old.response)), replayed: true };
            const d = await device(this.env, deviceId);
            if (
                action === "UPGRADE_FIRMWARE" &&
                expectedReleaseId &&
                d.firmwareTarget !== expectedReleaseId
            )
                throw new ApiError(409, "FIRMWARE_TARGET_CONFLICT");
            if (principal.kind !== "DEVICE") {
                const active = await db(this.env)
                    .prepare(
                        "SELECT * FROM service_credentials WHERE credentialId=? AND revokedAt IS NULL"
                    )
                    .bind(principal.credentialId)
                    .first<{ permissions: string; sites: string; scopes: string }>();
                if (!active || !JSON.parse(active.permissions).includes("commands:write"))
                    throw new ApiError(403, "FORBIDDEN");
                grants(
                    {
                        ...principal,
                        sites: JSON.parse(active.sites),
                        scopes: JSON.parse(active.scopes),
                    },
                    d.siteId,
                    d.scopeId
                );
            }
            const ws = this.socket(d);
            if (!ws || !d.credentialHash) throw new ApiError(409, "DEVICE_OFFLINE");
            if (!JSON.parse(d.capabilities).includes(action))
                throw new ApiError(409, "CAPABILITY_UNSUPPORTED");
            const now = Date.now(),
                operationId = crypto.randomUUID();
            const payload: Record<string, unknown> = { previousBootId: d.bootId };
            if (action === "APPLY_CONFIG") {
                Object.assign(payload, {
                    revision: d.configRevision,
                    scopeId: d.scopeId,
                    qrBaseUrl: d.qrBaseUrl,
                });
                const network = await db(this.env)
                    .prepare("SELECT ssid FROM device_network_config WHERE deviceId=?")
                    .bind(deviceId)
                    .first<{ ssid: string }>();
                if (network) {
                    const status = await db(this.env)
                        .prepare(
                            "SELECT runtimeConfigVersion FROM device_runtime_status WHERE deviceId=? AND generation=? AND sessionId=?"
                        )
                        .bind(deviceId, d.generation, d.currentSession)
                        .first<{ runtimeConfigVersion: number | null }>();
                    if (status?.runtimeConfigVersion !== 1)
                        throw new ApiError(409, "RUNTIME_CONFIG_UNSUPPORTED");
                    Object.assign(payload, { runtimeConfigVersion: 1, wifiSsid: network.ssid });
                }
            }
            if (action === "ROTATE_QR_KEY") payload.nonce = randomToken();
            if (action === "UPGRADE_FIRMWARE") {
                const release = await db(this.env)
                    .prepare(
                        "SELECT r.* FROM firmware_releases r JOIN publisher_keys p ON p.keyId=r.publisherKeyId WHERE r.releaseId=? AND r.state='APPROVED' AND r.verified=1 AND p.revokedAt IS NULL"
                    )
                    .bind(d.firmwareTarget)
                    .first<{
                        releaseId: string;
                        buildId: string;
                        hardwareTarget: string;
                        version: string;
                        size: number;
                    }>();
                if (
                    !release ||
                    release.hardwareTarget !== d.hardwareTarget ||
                    !d.otaSlotBytes ||
                    release.size > d.otaSlotBytes ||
                    !valid(d.firmwareVersion ?? "") ||
                    !gt(release.version, d.firmwareVersion!)
                )
                    throw new ApiError(409, "FIRMWARE_INCOMPATIBLE");
                Object.assign(payload, {
                    releaseId: release.releaseId,
                    buildId: release.buildId,
                    version: release.version,
                    manifestPath: `/api/devices/${deviceId}/firmware/${release.releaseId}/manifest`,
                });
            }
            const op: z.infer<typeof S.Operation> = {
                operationId,
                deviceId,
                generation: d.generation,
                action,
                source: principal.kind === "DEVICE" ? "LOCAL" : "ADMIN",
                state: "CREATED",
                createdAt: now,
                deadline: now + S.deadlines[action],
                ackDeadline: now + 10000,
                payload,
                result: null,
                actorId,
                clientId: principal.clientId,
            };
            this.ctx.storage.sql.exec(
                "INSERT INTO intents VALUES(?,?,'created',?)",
                operationId,
                deviceId,
                op.ackDeadline
            );
            await this.schedule(op.ackDeadline);
            try {
                await db(this.env).batch([
                    this.authorityGuard(d, this.attachment(ws).sessionId),
                    ...this.serviceGuard(principal, d),
                    ...this.targetGuard(d, action, payload),
                    claim(this.env, i, op, 202),
                    this.env.DB.prepare(
                        "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
                    ).bind(
                        operationId,
                        deviceId,
                        d.generation,
                        action,
                        op.source,
                        op.state,
                        now,
                        op.deadline,
                        op.ackDeadline,
                        JSON.stringify(payload),
                        null,
                        actorId,
                        principal.clientId
                    ),
                    audit(
                        this.env,
                        principal,
                        actorId,
                        "OPERATION_CREATED",
                        d,
                        JSON.stringify({ operationId, action, source: op.source })
                    ),
                    this.env.DB.prepare("DELETE FROM transaction_guard"),
                ]);
            } catch (e) {
                this.ctx.storage.sql.exec("DELETE FROM intents WHERE operationId=?", operationId);
                const race = await replay(this.env, i);
                if (race)
                    return {
                        operation: parse(S.Operation, JSON.parse(race.response)),
                        replayed: true,
                    };
                if (/constraint|CONSTRAINT/.test(String(e)))
                    throw new ApiError(409, "OPERATION_CONFLICT");
                throw e;
            }
            this.ctx.storage.sql.exec(
                "UPDATE intents SET phase='dispatch' WHERE operationId=?",
                operationId
            );
            await db(this.env).batch([
                this.authorityGuard(d, this.attachment(ws).sessionId),
                ...this.serviceGuard(principal, d),
                ...this.targetGuard(d, action, payload),
                this.env.DB.prepare(
                    "UPDATE operations SET state='SENT' WHERE operationId=? AND state='CREATED'"
                ).bind(operationId),
                changed(this.env),
                this.env.DB.prepare("DELETE FROM transaction_guard"),
            ]);
            try {
                this.send(ws, {
                    version: 1,
                    type: "COMMAND",
                    eventId: crypto.randomUUID(),
                    operationId,
                    payload: { action, deadline: op.deadline, parameters: payload },
                });
            } catch {
                await db(this.env)
                    .prepare(
                        "UPDATE operations SET state='UNKNOWN' WHERE operationId=? AND state='SENT'"
                    )
                    .bind(operationId)
                    .run();
            }
            return { operation: op, replayed: false };
        } catch (e) {
            if (e instanceof ApiError) return { error: { status: e.status, code: e.code } };
            throw e;
        }
    }
    private async rotationReply(ws: WebSocket, op: OperationRow) {
        const key = await db(this.env)
            .prepare(
                "SELECT keyId,state FROM qr_keys WHERE operationId=? AND state IN('PENDING','ACTIVE')"
            )
            .bind(op.operationId)
            .first<{ keyId: string; state: string }>();
        if (!key) return;
        const nonce = (JSON.parse(op.payload) as { nonce: string }).nonce;
        if (key.state === "ACTIVE" && op.state === "SUCCEEDED")
            this.send(ws, {
                version: 1,
                type: "KEY_CONFIRMED",
                eventId: crypto.randomUUID(),
                operationId: op.operationId,
                payload: { keyId: key.keyId },
            });
        else if (key.state === "PENDING" && !S.finalStates.some((s) => s === op.state))
            this.send(ws, {
                version: 1,
                type: "KEY_COMMIT",
                eventId: crypto.randomUUID(),
                operationId: op.operationId,
                payload: { keyId: key.keyId, nonce },
            });
    }
    private async bootReconciliation(ws: WebSocket, d: DeviceRow) {
        const rotation = await db(this.env)
            .prepare(
                "SELECT * FROM operations WHERE deviceId=? AND generation=? AND action='ROTATE_QR_KEY' AND state IN('SENT','ACKNOWLEDGED','RUNNING','UNKNOWN','SUCCEEDED') ORDER BY createdAt DESC LIMIT 1"
            )
            .bind(d.deviceId, d.generation)
            .first<OperationRow>();
        if (rotation) await this.rotationReply(ws, rotation);
    }
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        try {
            if (typeof message !== "string") {
                ws.close(1003, "TEXT_REQUIRED");
                return;
            }
            if (new TextEncoder().encode(message).byteLength > 16384) {
                ws.close(1009, "PAYLOAD_TOO_LARGE");
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(message);
            } catch {
                ws.close(1008, "INVALID_JSON");
                return;
            }
            const check = S.DeviceMessage.safeParse(parsed);
            if (!check.success) {
                ws.close(1008, "INVALID_MESSAGE");
                return;
            }
            const m = check.data,
                { d } = await this.authority(ws);
            const a = this.attachment(ws);
            const bucket = Math.floor(Date.now() / 60000);
            a.count = a.bucket === bucket ? a.count + 1 : 1;
            a.bucket = bucket;
            a.lastSeenAt = Date.now();
            ws.serializeAttachment(a);
            if (a.count > 120) {
                ws.close(1013, "RATE_LIMITED");
                return;
            }
            if (a.bootId === null && m.type !== "BOOT_REPORT")
                throw new ApiError(409, "BOOT_REQUIRED");
            const fingerprint = await hash(canonical(m));
            const existing = await db(this.env)
                .prepare(
                    "SELECT fingerprint FROM device_events WHERE deviceId=? AND generation=? AND eventId=?"
                )
                .bind(d.deviceId, d.generation, m.eventId)
                .first<{ fingerprint: string }>();
            const operationId = "operationId" in m ? m.operationId : undefined;
            const op = operationId
                ? await db(this.env)
                      .prepare(
                          "SELECT * FROM operations WHERE operationId=? AND deviceId=? AND generation=?"
                      )
                      .bind(operationId, d.deviceId, d.generation)
                      .first<OperationRow>()
                : null;
            if (existing) {
                if (existing.fingerprint !== fingerprint) throw new ApiError(409, "EVENT_CONFLICT");
                if (m.type === "BOOT_REPORT" && a.bootId === null) {
                    if (m.payload.bootId !== d.bootId) throw new ApiError(409, "BOOT_MISMATCH");
                    a.bootId = m.payload.bootId;
                    ws.serializeAttachment(a);
                    await this.bootReconciliation(ws, d);
                }
                if (op) await this.rotationReply(ws, op);
                this.ack(ws, m.eventId);
                return;
            }
            const writes: D1PreparedStatement[] = [this.authorityGuard(d, a.sessionId)];
            if (m.type === "BOOT_REPORT" || m.type === "DEVICE_STATUS") {
                const b = m.payload;
                if (!valid(b.firmwareVersion)) throw new ApiError(422, "INVALID_VERSION");
                const key = await db(this.env)
                    .prepare(
                        "SELECT state FROM qr_keys WHERE keyId=? AND deviceId=? AND generation=?"
                    )
                    .bind(b.keyId, d.deviceId, d.generation)
                    .first();
                if (!key) throw new ApiError(409, "KEY_NOT_TRUSTED");
                if (m.type === "DEVICE_STATUS" && b.bootId !== a.bootId)
                    throw new ApiError(409, "BOOT_MISMATCH");
                if (b.appliedRevision > d.configRevision)
                    throw new ApiError(409, "REVISION_CONFLICT");
                writes.push(
                    this.env.DB.prepare(
                        "UPDATE devices SET bootId=?,hardwareTarget=?,firmwareVersion=?,buildId=?,otaSlotBytes=?,capabilities=?,appliedRevision=max(appliedRevision,?),reportedHealthy=?,lastSeenAt=?,confirmedAt=coalesce(confirmedAt,?) WHERE deviceId=? AND generation=? AND currentSession=?"
                    ).bind(
                        b.bootId,
                        b.hardwareTarget,
                        b.firmwareVersion,
                        b.buildId,
                        b.otaSlotBytes,
                        JSON.stringify(b.capabilities),
                        b.appliedRevision,
                        Number(b.healthy),
                        Date.now(),
                        Date.now(),
                        d.deviceId,
                        d.generation,
                        a.sessionId
                    ),
                    changed(this.env)
                );
                if (m.type === "DEVICE_STATUS" && operationId) {
                    if (!op || op.action !== "REQUEST_STATUS")
                        throw new ApiError(409, "OPERATION_INVALID");
                    writes.push(...this.finishWrites(op, { success: true }, d));
                }
                writes.push(
                    this.env.DB.prepare(
                        "INSERT INTO device_presence VALUES(?,?,?,'ONLINE',?) ON CONFLICT(deviceId) DO UPDATE SET generation=excluded.generation,sessionId=excluded.sessionId,state=excluded.state,observedAt=excluded.observedAt"
                    ).bind(d.deviceId, d.generation, a.sessionId, Date.now())
                );
                writes.push(
                    this.env.DB.prepare(
                        "INSERT INTO device_runtime_status VALUES(?,?,?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET generation=excluded.generation,sessionId=excluded.sessionId,observedAt=excluded.observedAt,runtimeConfigVersion=excluded.runtimeConfigVersion,wifiSsid=excluded.wifiSsid,timeReport=excluded.timeReport"
                    ).bind(
                        d.deviceId,
                        d.generation,
                        a.sessionId,
                        Date.now(),
                        b.runtimeConfigVersion ?? null,
                        b.wifiSsid ?? null,
                        b.time ? JSON.stringify(b.time) : null
                    )
                );
            } else if (m.type === "LOCAL_REQUEST") {
                const i: Intent = {
                    clientId: `local_${await hash(`${d.deviceId}:${d.generation}`)}`,
                    key: m.eventId,
                    action: `local:${d.deviceId}`,
                    fingerprint: await hash(canonical(m.payload)),
                };
                const p: Principal = {
                    clientId: i.clientId,
                    credentialId: d.deviceId,
                    kind: "DEVICE",
                    permissions: [],
                    sites: [d.siteId],
                    scopes: [d.scopeId],
                };
                const result = await this.startOperation(
                    d.deviceId,
                    m.payload.action,
                    i,
                    p,
                    d.deviceId
                );
                if (result.error) throw new ApiError(result.error.status, result.error.code);
            } else {
                if (!op) throw new ApiError(409, "OPERATION_INVALID");
                if (m.type === "COMMAND_ACK" || m.type === "COMMAND_PROGRESS") {
                    const state = advance(op.state, m.type === "COMMAND_ACK" ? "ACK" : "PROGRESS");
                    writes.push(
                        this.env.DB.prepare(
                            "UPDATE operations SET state=? WHERE operationId=? AND state=?"
                        ).bind(state, op.operationId, op.state),
                        changed(this.env)
                    );
                    if (m.type === "COMMAND_PROGRESS" && !S.finalStates.some((s) => s === op.state))
                        writes.push(
                            this.env.DB.prepare(
                                "INSERT INTO operation_progress VALUES(?,?,?) ON CONFLICT(operationId) DO UPDATE SET percent=max(percent,excluded.percent),updatedAt=max(updatedAt,excluded.updatedAt)"
                            ).bind(op.operationId, m.payload.progress, Date.now())
                        );
                } else if (m.type === "COMMAND_RESULT") {
                    if (op.action === "REQUEST_STATUS" && m.payload.success)
                        throw new ApiError(409, "STATUS_REPORT_REQUIRED");
                    writes.push(...this.finishWrites(op, m.payload, d));
                    if (op.action === "APPLY_CONFIG" && m.payload.success)
                        writes.push(
                            this.env.DB.prepare(
                                "UPDATE devices SET appliedRevision=max(appliedRevision,?) WHERE deviceId=? AND generation=?"
                            ).bind(m.payload.revision!, d.deviceId, d.generation)
                        );
                } else if (m.type === "KEY_PROPOSAL" || m.type === "KEY_ACTIVATED") {
                    if (
                        op.action !== "ROTATE_QR_KEY" ||
                        ["CREATED", "FAILED", "EXPIRED"].includes(op.state)
                    )
                        throw new ApiError(409, "OPERATION_INVALID");
                    const p = JSON.parse(op.payload) as { nonce: string },
                        newKeyId = await hash(unb64(m.payload.publicKey));
                    if (
                        p.nonce !== m.payload.nonce ||
                        !(await verifyDeviceSignature(
                            m.payload.publicKey,
                            m.payload.proof,
                            rotationBytes(
                                m.type === "KEY_PROPOSAL" ? "PROPOSE" : "ACTIVATE",
                                op.operationId,
                                d.deviceId,
                                d.generation,
                                p.nonce,
                                newKeyId
                            )
                        ))
                    )
                        throw new ApiError(422, "PROOF_INVALID");
                    const candidate = await db(this.env)
                        .prepare("SELECT keyId,state FROM qr_keys WHERE operationId=?")
                        .bind(op.operationId)
                        .first<{ keyId: string; state: string }>();
                    if (candidate && candidate.keyId !== newKeyId)
                        throw new ApiError(409, "KEY_CONFLICT");
                    if (m.type === "KEY_PROPOSAL") {
                        if (!candidate)
                            writes.push(
                                this.env.DB.prepare(
                                    "INSERT INTO qr_keys VALUES(?,?,?,?,'PENDING',?,?)"
                                ).bind(
                                    newKeyId,
                                    d.deviceId,
                                    d.generation,
                                    m.payload.publicKey,
                                    op.operationId,
                                    Date.now()
                                )
                            );
                    } else {
                        if (!candidate || candidate.state === "REVOKED")
                            throw new ApiError(409, "KEY_NOT_PENDING");
                        if (candidate.state === "PENDING") {
                            writes.push(
                                this.env.DB.prepare(
                                    "UPDATE qr_keys SET state='REVOKED' WHERE deviceId=? AND generation=? AND state='ACTIVE'"
                                ).bind(d.deviceId, d.generation),
                                this.env.DB.prepare(
                                    "UPDATE qr_keys SET state='ACTIVE' WHERE operationId=? AND keyId=? AND state='PENDING'"
                                ).bind(op.operationId, newKeyId),
                                changed(this.env),
                                this.env.DB.prepare(
                                    "UPDATE operations SET state='SUCCEEDED',result=? WHERE operationId=? AND state NOT IN('SUCCEEDED','FAILED','EXPIRED')"
                                ).bind(
                                    JSON.stringify({ success: true, keyId: newKeyId }),
                                    op.operationId
                                ),
                                changed(this.env)
                            );
                        }
                    }
                }
            }
            writes.push(
                this.env.DB.prepare("INSERT INTO device_events VALUES(?,?,?,?,?,?,?)").bind(
                    d.deviceId,
                    d.generation,
                    m.eventId,
                    fingerprint,
                    m.type,
                    operationId ?? null,
                    Date.now()
                ),
                audit(
                    this.env,
                    { clientId: "device" },
                    d.deviceId,
                    m.type,
                    d,
                    JSON.stringify({ eventId: m.eventId, ...(operationId ? { operationId } : {}) })
                ),
                this.env.DB.prepare("DELETE FROM transaction_guard")
            );
            await db(this.env).batch(writes);
            if (m.type === "BOOT_REPORT") {
                a.bootId = m.payload.bootId;
                ws.serializeAttachment(a);
                await this.bootReconciliation(ws, d);
            }
            if (op && (m.type === "KEY_PROPOSAL" || m.type === "KEY_ACTIVATED")) {
                const latest = await db(this.env)
                    .prepare("SELECT * FROM operations WHERE operationId=?")
                    .bind(op.operationId)
                    .first<OperationRow>();
                if (latest) await this.rotationReply(ws, latest);
            }
            this.ack(ws, m.eventId);
            if (op) await this.cleanFinished(op.operationId);
        } catch (e) {
            if (ws.readyState !== 1) return;
            if (e instanceof ApiError && e.code === "RESULT_CONFLICT") {
                try {
                    const { a, d } = await this.authority(ws);
                    await db(this.env).batch([
                        this.authorityGuard(d, a.sessionId),
                        audit(this.env, { clientId: "device" }, d.deviceId, "RESULT_CONFLICT", d),
                        this.env.DB.prepare("DELETE FROM transaction_guard"),
                    ]);
                } catch {
                    e = new ApiError(503, "STORAGE_UNAVAILABLE");
                }
            }
            if (ws.readyState !== 1) return;
            if (e instanceof ApiError)
                this.send(ws, {
                    version: 1,
                    type: "ERROR",
                    eventId: crypto.randomUUID(),
                    payload: { code: e.code },
                });
            else
                this.send(ws, {
                    version: 1,
                    type: "ERROR",
                    eventId: crypto.randomUUID(),
                    payload: { code: "STORAGE_UNAVAILABLE" },
                });
        }
    }
    private finishWrites(
        op: OperationRow,
        result: z.infer<typeof S.Result>,
        d: DeviceRow
    ): D1PreparedStatement[] {
        if (["SUCCEEDED", "FAILED", "EXPIRED"].includes(op.state)) {
            if (canonical(JSON.parse(op.result ?? "null")) !== canonical(result))
                throw new ApiError(409, "RESULT_CONFLICT");
            return [];
        }
        if (op.state === "CREATED") throw new ApiError(409, "RESULT_CONFLICT");
        const state = resultState(op, result, d);
        return [
            this.env.DB.prepare(
                "UPDATE operations SET state=?,result=? WHERE operationId=? AND state=?"
            ).bind(state, JSON.stringify(result), op.operationId, op.state),
            changed(this.env),
            ...(op.action === "ROTATE_QR_KEY" && !result.success
                ? [
                      this.env.DB.prepare(
                          "UPDATE qr_keys SET state='REVOKED' WHERE operationId=? AND state='PENDING'"
                      ).bind(op.operationId),
                  ]
                : []),
        ];
    }
    private async cleanFinished(operationId: string) {
        const o = await db(this.env)
            .prepare("SELECT state FROM operations WHERE operationId=?")
            .bind(operationId)
            .first<{ state: string }>();
        if (o && ["SUCCEEDED", "FAILED", "EXPIRED"].includes(o.state))
            this.ctx.storage.sql.exec("DELETE FROM intents WHERE operationId=?", operationId);
    }
    async alarm() {
        try {
            await this.recoverAlarm();
        } catch {
            await this.ctx.storage.setAlarm(Date.now() + 10000);
        }
    }
    private async recoverAlarm() {
        await this.reconcile();
        for (const i of this.ctx.storage.sql
            .exec<RecoveryIntent>("SELECT * FROM intents")
            .toArray()) {
            const op = await db(this.env)
                .prepare("SELECT * FROM operations WHERE operationId=?")
                .bind(i.operationId)
                .first<OperationRow>();
            if (!op) {
                this.ctx.storage.sql.exec("DELETE FROM intents WHERE operationId=?", i.operationId);
                continue;
            }
            if (["SUCCEEDED", "FAILED", "EXPIRED"].includes(op.state)) {
                await this.cleanFinished(op.operationId);
                continue;
            }
            if (i.due > Date.now()) continue;
            const state =
                op.state === "CREATED" && i.phase === "created"
                    ? "EXPIRED"
                    : op.state === "CREATED" || op.state === "SENT" || Date.now() >= op.deadline
                      ? "UNKNOWN"
                      : op.state;
            if (state !== op.state)
                await db(this.env)
                    .prepare("UPDATE operations SET state=? WHERE operationId=? AND state=?")
                    .bind(state, op.operationId, op.state)
                    .run();
            if (state === "UNKNOWN" || state === "EXPIRED")
                this.ctx.storage.sql.exec("DELETE FROM intents WHERE operationId=?", i.operationId);
            else
                this.ctx.storage.sql.exec(
                    "UPDATE intents SET due=? WHERE operationId=?",
                    op.deadline,
                    op.operationId
                );
        }
        const earliest = this.ctx.storage.sql
            .exec<{ due: number }>("SELECT min(due) AS due FROM intents")
            .one().due;
        const closure = this.ctx.storage.sql
            .exec("SELECT deviceId FROM closures LIMIT 1")
            .toArray().length;
        if (closure) await this.ctx.storage.setAlarm(Date.now() + 1000);
        else if (earliest !== null)
            await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, earliest));
    }
    async webSocketError(ws: WebSocket) {
        ws.close(1011, "CONNECTION_ERROR");
    }
}
