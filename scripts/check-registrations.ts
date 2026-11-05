import assert from "node:assert/strict";
import { cmsRuntime } from "./cms-runtime";
import { b64, bytes, hash, randomToken } from "../src/crypto";
import * as R from "../src/registration-contracts";
import { PairingResult } from "../src/contracts";

const { mf, base } = await cmsRuntime(8791);
try {
    const db = await mf.getD1Database("DB", "backend");
    const post = (path: string, input: unknown) =>
        fetch(base + "/api/" + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        });
    async function identity() {
        const key = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
        );
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
        return {
            publicKey: b64(raw),
            keyId: await hash(raw),
            sign: async (message: string) => b64(new Uint8Array(await crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" }, key.privateKey, bytes(message)
            ))),
        };
    }
    async function create(id: Awaited<ReturnType<typeof identity>>, serial?: string) {
        const response = await post("device-registrations", {
            publicKey: id.publicKey, hardwareTarget: "esp32_check", ...(serial ? { serial } : {}),
        });
        assert.equal(response.status, 201);
        return R.RegistrationChallenge.parse(await response.json());
    }
    async function signed(
        id: Awaited<ReturnType<typeof identity>>,
        challenge: Awaited<ReturnType<typeof create>>
    ) {
        return {
            nonce: challenge.nonce,
            proof: await id.sign(R.registrationBytes({ ...challenge, keyId: id.keyId })),
        };
    }
    const path = (registrationId: string) => "device-registrations/" + registrationId + "/complete";
    const countDevices = async () =>
        (await db.prepare("SELECT count(*) AS n FROM devices").first<{ n: number }>())!.n;
    const stored = (registrationId: string) => db.prepare(
        "SELECT state,deviceId,publicKey,attempts FROM device_registrations WHERE registrationId=?"
    ).bind(registrationId).first<{ state: string; deviceId: string | null; publicKey: string; attempts: number }>();

    const id = await identity(), challenge = await create(id, "  Lobby 1  ");
    assert.equal(R.registrationBytes({ ...challenge, keyId: id.keyId }),
        "REGISTER_V1|" + challenge.registrationId + "|" + challenge.nonce + "|" + id.keyId);
    const replacement = await create(id);
    assert.deepEqual(await stored(challenge.registrationId), {
        state: "CHALLENGE", deviceId: null, publicKey: id.publicKey, attempts: 0,
    });
    const proof = await signed(id, challenge);
    assert.equal((await post(path(challenge.registrationId), { ...proof, nonce: randomToken() })).status, 401);
    assert.equal((await stored(challenge.registrationId))!.attempts, 0);
    assert.equal((await post(path(challenge.registrationId), {
        nonce: challenge.nonce, proof: b64(new Uint8Array(64)),
    })).status, 422);
    assert.equal((await stored(challenge.registrationId))!.attempts, 1);
    assert.equal(await countDevices(), 0);

    const response = await post(path(challenge.registrationId), proof);
    assert.equal(response.status, 201);
    const completed = PairingResult.parse(await response.json());
    assert.equal(completed.keyId, id.keyId);
    assert.equal(completed.generation, 1);
    assert.equal((await stored(challenge.registrationId))!.state, "COMPLETED");
    assert.equal((await post(path(challenge.registrationId), proof)).status, 409);
    assert.equal(await countDevices(), 1);
    const device = await db.prepare("SELECT name,credentialHash,confirmedAt FROM devices WHERE deviceId=?")
        .bind(completed.deviceId).first<{ name: string; credentialHash: string; confirmedAt: number | null }>();
    assert.equal(device!.name, "Lobby 1");
    assert.equal(device!.credentialHash, await hash(completed.token));
    assert.equal(device!.confirmedAt, null);
    const t = String(Math.floor(Date.now() / 30000) * 30);
    const qr = new URLSearchParams({ v: "1", did: completed.deviceId, t,
        sig: await id.sign("v1." + completed.deviceId + "." + t) });
    assert.equal((await fetch(base + "/checkin?" + qr)).status, 200);

    const columns = await db.prepare("PRAGMA table_info(devices)").all<{ name: string }>();
    for (const removed of ["doorId", "configRevision", "appliedRevision"])
        assert.equal(columns.results.some((column: { name: string }) => column.name === removed), false);
    const cms = (suffix: string, method = "GET", input?: unknown, key = crypto.randomUUID()) =>
        fetch(base + "/cms-api/devices/" + completed.deviceId + suffix, {
            method,
            headers: { "content-type": "application/json", origin: base, "idempotency-key": key },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
    assert.equal((await cms("", "PATCH", { name: "Cửa chính" })).status, 200);
    const overview = await (await cms("/overview")).json() as Record<string, unknown>;
    const overviewDevice = overview.device as Record<string, unknown>;
    assert.equal(overviewDevice.name, "Cửa chính");
    assert.equal(overview.activeKeyId, id.keyId);
    for (const removed of ["keys", "config", "lastSyncedAtMs", "doorId", "configRevision", "appliedRevision"])
        assert.equal(removed in overview || removed in overviewDevice, false);
    assert.equal((await cms("/network-config", "PATCH", { ssid: "LobbyWifi", password: "test-password" })).status, 200);

    const connection = await mf.dispatchFetch(base + "/api/devices/" + completed.deviceId + "/connection", {
        headers: { upgrade: "websocket", authorization: "Bearer " + completed.token },
    });
    assert.equal(connection.status, 101);
    const ws = connection.webSocket!;
    type Message = { type: string; operationId?: string; payload: Record<string, unknown> };
    const inbox: Message[] = [];
    const waiters: (() => void)[] = [];
    ws.addEventListener("message", (event) => {
        inbox.push(JSON.parse(String(event.data)) as Message);
        waiters.splice(0).forEach((wake) => wake());
    });
    async function message(type: string) {
        const deadline = Date.now() + 5000;
        while (true) {
            const index = inbox.findIndex((item) => item.type === type);
            if (index !== -1) return inbox.splice(index, 1)[0]!;
            assert.ok(Date.now() < deadline, "Missing WebSocket message: " + type + "; received " + JSON.stringify(inbox));
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 100);
                waiters.push(() => { clearTimeout(timer); resolve(); });
            });
        }
    }
    ws.accept();
    await message("WELCOME");
    ws.send(JSON.stringify({ version: 1, type: "BOOT_REPORT", eventId: crypto.randomUUID(), payload: {
        bootId: "boot_test", keyId: id.keyId, hardwareTarget: "esp32_check", firmwareVersion: "1.0.0",
        buildId: "build_test", otaSlotBytes: 1024 * 1024, capabilities: ["APPLY_CONFIG"], healthy: true,
        runtimeConfigVersion: 1, wifiSsid: "OldWifi",
    } }));
    await message("EVENT_ACK");
    const applyResponse = await cms("/commands", "POST", { action: "APPLY_CONFIG" });
    assert.equal(applyResponse.status, 202, await applyResponse.clone().text());
    const apply = await applyResponse.json() as { operationId: string; payload: Record<string, unknown> };
    const command = await message("COMMAND");
    assert.equal(command.operationId, apply.operationId);
    assert.equal("revision" in apply.payload, false);
    const state = async () => (await db.prepare("SELECT state FROM operations WHERE operationId=?")
        .bind(apply.operationId).first<{ state: string }>())!.state;
    assert.equal(await state(), "SENT");
    const blockedEdits = async () => {
        assert.equal((await cms("/network-config", "PATCH", { ssid: "OtherWifi", password: "other-password" })).status, 409);
        assert.equal((await cms("/config", "PATCH", { scopeId: "scope", qrBaseUrl: "https://example.com/qr" })).status, 409);
    };
    await blockedEdits();
    await db.prepare("UPDATE operations SET state='UNKNOWN' WHERE operationId=?").bind(apply.operationId).run();
    await blockedEdits();
    const download = await fetch(base + "/api/devices/" + completed.deviceId + "/network-config?operationId=" + apply.operationId, {
        headers: { authorization: "Bearer " + completed.token },
    });
    assert.equal(download.status, 200);
    assert.deepEqual(await download.json(), { ssid: "LobbyWifi", password: "test-password" });
    const result = (ssid: string) => ws.send(JSON.stringify({ version: 1, type: "COMMAND_RESULT",
        eventId: crypto.randomUUID(), operationId: apply.operationId,
        payload: { success: true, runtimeConfigVersion: 1, wifiSsid: ssid },
    }));
    result("WrongWifi");
    assert.equal((await message("ERROR")).payload.code, "RESULT_EVIDENCE_REQUIRED");
    assert.equal(await state(), "UNKNOWN");
    result("LobbyWifi");
    await message("EVENT_ACK");
    assert.equal(await state(), "SUCCEEDED");
    assert.equal((await cms("/network-config", "PATCH", { ssid: "LobbyWifi" })).status, 200);
    ws.close();

    const revokeIntent = crypto.randomUUID();
    assert.equal((await cms("/key-revocations", "POST", { keyId: id.keyId }, revokeIntent)).status, 200);
    const rotated = await identity();
    await db.prepare("INSERT INTO qr_keys VALUES(?,?,?,?,'ACTIVE',NULL,?)")
        .bind(rotated.keyId, completed.deviceId, 1, rotated.publicKey, Date.now()).run();
    const rotatedState = async () => (await db.prepare("SELECT state FROM qr_keys WHERE keyId=?")
        .bind(rotated.keyId).first<{ state: string }>())!.state;
    const revokeReplay = await cms("/key-revocations", "POST", { keyId: id.keyId }, revokeIntent);
    assert.equal(revokeReplay.status, 200);
    assert.equal(revokeReplay.headers.get("idempotency-replayed"), "true");
    assert.equal((await cms("/key-revocations", "POST", { keyId: id.keyId })).status, 409);
    assert.equal(await rotatedState(), "ACTIVE");
    assert.equal((await (await cms("/overview")).json() as { activeKeyId: string }).activeKeyId, rotated.keyId);
    // Simulate the generation change used by recovery: stale key metadata must not target the new identity.
    await db.prepare("UPDATE operations SET state='UNKNOWN' WHERE operationId=?").bind(apply.operationId).run();
    await db.prepare("UPDATE devices SET generation=2 WHERE deviceId=?").bind(completed.deviceId).run();
    assert.equal((await cms("/network-config", "PATCH", { ssid: "LobbyWifi" })).status, 200);
    assert.equal((await (await cms("/overview")).json() as { activeKeyId: string | null }).activeKeyId, null);
    assert.equal((await cms("/key-revocations", "POST", { keyId: rotated.keyId })).status, 409);
    assert.equal(await rotatedState(), "ACTIVE");
    const recovered = await identity();
    await db.prepare("UPDATE qr_keys SET state='REVOKED' WHERE deviceId=?").bind(completed.deviceId).run();
    await db.prepare("INSERT INTO qr_keys VALUES(?,?,?,?,'ACTIVE',NULL,?)")
        .bind(recovered.keyId, completed.deviceId, 2, recovered.publicKey, Date.now()).run();
    assert.equal((await cms("/key-revocations", "POST", { keyId: rotated.keyId })).status, 409);
    assert.equal((await (await cms("/overview")).json() as { activeKeyId: string }).activeKeyId, recovered.keyId);
    assert.equal((await cms("/key-revocations", "POST", { keyId: recovered.keyId })).status, 200);

    const retryId = await identity(), retry = await create(retryId, "   ");
    const retryProof = await signed(retryId, retry);
    const retries = await Promise.all([
        post(path(retry.registrationId), retryProof), post(path(retry.registrationId), retryProof),
    ]);
    assert.deepEqual(retries.map((r) => r.status).sort(), [201, 409]);
    const retryResult = PairingResult.parse(await retries.find((r) => r.status === 201)!.json());
    assert.equal(await countDevices(), 2);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM audit WHERE deviceId=? AND action='DEVICE_REGISTRATION_COMPLETED'")
        .bind(retryResult.deviceId).first<{ n: number }>())!.n, 1);
    assert.equal((await db.prepare("SELECT name FROM devices WHERE deviceId=?")
        .bind(retryResult.deviceId).first<{ name: string }>())!.name, "esp32_check");

    const duplicateId = await identity();
    const duplicates = await Promise.all([create(duplicateId), create(duplicateId)]);
    const duplicateRequests = await Promise.all(duplicates.map(async (r) =>
        post(path(r.registrationId), await signed(duplicateId, r))));
    assert.deepEqual(duplicateRequests.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await countDevices(), 3);
    await db.prepare("UPDATE qr_keys SET state='REVOKED' WHERE keyId=?").bind(id.keyId).run();
    assert.equal((await post("device-registrations", {
        publicKey: id.publicKey, hardwareTarget: "esp32_check",
    })).status, 409);
    assert.equal((await post(path(replacement.registrationId), await signed(id, replacement))).status, 409);
    assert.equal(await countDevices(), 3);
    assert.equal((await fetch(base + "/checkin?" + qr)).status, 401);

    const expiredId = await identity(), expired = await create(expiredId);
    await db.prepare("UPDATE device_registrations SET expiresAt=? WHERE registrationId=?")
        .bind(Date.now() - 1, expired.registrationId).run();
    assert.equal((await post(path(expired.registrationId), await signed(expiredId, expired))).status, 410);

    const lockedId = await identity(), locked = await create(lockedId);
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await post(path(locked.registrationId), {
        nonce: locked.nonce, proof: b64(new Uint8Array(64)),
    })).status, 422);
    assert.equal((await post(path(locked.registrationId), await signed(lockedId, locked))).status, 409);
    assert.equal((await stored(locked.registrationId))!.state, "LOCKED");
    assert.equal(await countDevices(), 3);

    assert.equal((await fetch(base + "/cms-api/device-registrations")).status, 404);
    assert.equal((await fetch(base + "/cms-api/devices/" + completed.deviceId + "/registration")).status, 404);

    for (const suffix of ["submit", "status", "claim"]) assert.equal((await post(
        "device-registrations/" + challenge.registrationId + "/" + suffix, {}
    )).status, 404);
    assert.equal((await post("admin/device-registrations/" + challenge.registrationId + "/approve", {})).status, 404);
    assert.equal((await fetch(base + "/api/admin/device-registrations/" + challenge.registrationId, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(base + "/cms-api/device-registrations/" + challenge.registrationId + "/approve", { method: "POST" })).status, 404);
    assert.equal((await fetch(base + "/cms-api/device-registrations/" + challenge.registrationId, { method: "DELETE" })).status, 404);
    const openapi = await (await fetch(base + "/openapi.json")).json() as { paths: Record<string, unknown> };
    for (const removed of ["submit", "status", "claim", "approve"]) assert.equal(
        Object.keys(openapi.paths).some((p) => p.includes("device-registrations/") && p.endsWith("/" + removed)), false
    );
    assert.ok(openapi.paths["/api/device-registrations/{registrationId}/complete"]);
    console.log("Registration/device workerd checks passed: automatic enrollment, proof, races, expiry, lockout, CMS cleanup, config dispatch/download/results, edit guards and exact-key revocation/replay across generations.");
} finally {
    await mf.dispose();
}
