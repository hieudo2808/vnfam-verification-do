import assert from "node:assert/strict";
import { cmsRuntime } from "./cms-runtime";
import { b64, bytes, hash, randomToken } from "../src/crypto";
import * as R from "../src/registration-contracts";
import { PairingResult, pageOf } from "../src/contracts";

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

    const listResponse = await fetch(base + "/cms-api/device-registrations?state=ALL");
    assert.equal(listResponse.status, 200);
    const list = pageOf(R.RegistrationMeta).parse(await listResponse.json());
    assert.ok(list.items.some((r) => r.registrationId === challenge.registrationId && r.state === "COMPLETED"));
    const defaultList = pageOf(R.RegistrationMeta).parse(await (await fetch(base + "/cms-api/device-registrations")).json());
    assert.deepEqual(defaultList, list);
    for (const state of ["COMPLETED", "EXPIRED", "LOCKED", "CHALLENGE"]) {
        const filtered = pageOf(R.RegistrationMeta).parse(await (await fetch(
            base + "/cms-api/device-registrations?state=" + state
        )).json());
        assert.ok(filtered.items.length > 0);
        assert.ok(filtered.items.every((r) => r.state === state));
    }
    const publicText = JSON.stringify(list);
    for (const secret of [challenge.nonce, completed.token, device!.credentialHash])
        assert.equal(publicText.includes(secret), false);
    await db.prepare("UPDATE device_registrations SET siteId='other_site' WHERE registrationId=?")
        .bind(locked.registrationId).run();
    await db.prepare("UPDATE device_registrations SET scopeId='other_scope' WHERE registrationId=?")
        .bind(expired.registrationId).run();
    const scoped = pageOf(R.RegistrationMeta).parse(await (await fetch(
        base + "/cms-api/device-registrations?state=ALL"
    )).json());
    assert.equal(scoped.items.some((r) => [locked.registrationId, expired.registrationId].includes(r.registrationId)), false);

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
    console.log("Registration workerd checks passed: proof, nonce protection, automatic enrollment, token, races, revocation, expiry, lockout, CMS scopes and removed approval flow.");
} finally {
    await mf.dispose();
}
