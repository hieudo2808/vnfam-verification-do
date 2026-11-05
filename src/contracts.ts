import { z } from "@hono/zod-openapi";
import { unb64 } from "./crypto";

export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const B64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
const canonicalB64 = (value: string) => {
    try {
        unb64(value);
        return true;
    } catch {
        return false;
    }
};
export const PublicKey = B64.length(43).refine(canonicalB64);
export const DevicePublicKey = z.union([
    PublicKey,
    B64.length(87).refine((value) => {
        try {
            const raw = unb64(value);
            return raw.length === 65 && raw[0] === 4;
        } catch {
            return false;
        }
    }),
]);
export const Signature = B64.length(86).refine(canonicalB64);
export const HttpsUrl = z.url().refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search;
});
export const QrDestination = z.union([z.literal(""), HttpsUrl]);
export const Permissions = z.enum([
    "devices:read",
    "devices:write",
    "pairings:write",
    "commands:write",
    "credentials:revoke",
    "keys:revoke",
    "firmware:write",
    "firmware:approve",
    "audit:read",
    "checkins:write",
    "checkins:read",
    "policy:write",
]);
export const ServiceProvision = z.strictObject({
    credentialId: Id,
    clientId: Id,
    kind: z.enum(["CMS", "MINIGAME", "OPERATOR"]),
    permissions: z.array(Permissions).min(1),
    sites: z.array(Id).min(1),
    scopes: z.array(Id).min(1),
});
export const DeviceInput = z.strictObject({
    deviceId: Id,
    name: z.string().min(1).max(200),
    siteId: Id,
    doorId: Id,
    scopeId: Id,
    qrBaseUrl: QrDestination.default(""),
});
export const DevicePatch = z.strictObject({
    name: z.string().min(1).max(200).optional(),
    siteId: Id.optional(),
    doorId: Id.optional(),
    checkInEnabled: z.boolean().optional(),
});
export const ConfigInput = z.strictObject({
    revision: z.number().int().positive(),
    scopeId: Id,
    qrBaseUrl: QrDestination,
});
export const Config = z.strictObject({
    revision: z.number().int().positive(),
    scopeId: Id,
    qrBaseUrl: QrDestination,
    appliedRevision: z.number().int().nonnegative(),
});
export const Device = DeviceInput.extend({
    checkInEnabled: z.boolean(),
    generation: z.number().int(),
    pairedAt: Time.nullable(),
    confirmedAt: Time.nullable(),
    configRevision: z.number().int(),
    appliedRevision: z.number().int(),
    firmwareTarget: Id.nullable(),
    bootId: Id.nullable(),
    hardwareTarget: Id.nullable(),
    firmwareVersion: z.string().nullable(),
    buildId: Id.nullable(),
    otaSlotBytes: z.number().int().nullable(),
    capabilities: z.array(z.string()),
    lastSeenAt: Time.nullable(),
    createdAt: Time,
    online: z.boolean().optional(),
});
export const PairingInput = z.strictObject({
    deviceId: Id,
    replaceIdentity: z.boolean().default(false),
});
export const PairingComplete = z.strictObject({
    pairingId: Id,
    code: B64.length(43),
    publicKey: DevicePublicKey,
    proof: Signature,
});
export const Pairing = z.strictObject({
    pairingId: Id,
    deviceId: Id,
    nonce: B64,
    expiresAt: Time,
    code: B64.optional(),
    state: z.enum(["PENDING", "CONSUMED", "CANCELLED", "LOCKED"]),
});
export const PairingResult = z.strictObject({
    deviceId: Id,
    generation: z.number().int(),
    keyId: PublicKey,
    token: B64,
});
export const QR = z.strictObject({
    version: z.literal(1),
    deviceId: Id,
    scopeId: Id,
    keyId: PublicKey,
    issuedAtMs: Time.refine((v) => v % 30_000 === 0),
    signature: Signature,
});
export const DisplayName = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\u0000-\u001f\u007f]*$/);
export const CheckInInput = z.strictObject({
    subjectId: Id,
    subjectName: DisplayName.optional(),
    scopeId: Id,
    qr: QR,
});
export const Receipt = z.strictObject({
    checkInId: Id,
    subjectId: Id,
    scopeId: Id,
    deviceId: Id,
    qrIssuedAtMs: Time,
    verifiedAtMs: Time,
});
export const Policy = z.strictObject({
    maxAgeMs: z.number().int().min(30_000).max(60_000),
    futureSkewMs: z.number().int().min(0).max(5_000),
});
export const Action = z.enum([
    "REQUEST_STATUS",
    "SYNC_TIME",
    "APPLY_CONFIG",
    "REBOOT",
    "RESET_WIFI",
    "SCAN_WIFI",
    "ROTATE_QR_KEY",
    "UPGRADE_FIRMWARE",
]);
export const CommandInput = z.strictObject({ action: Action.exclude(["UPGRADE_FIRMWARE"]) });
export const State = z.enum([
    "CREATED",
    "SENT",
    "ACKNOWLEDGED",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "UNKNOWN",
    "EXPIRED",
]);
export const Operation = z.strictObject({
    operationId: Id,
    deviceId: Id,
    generation: z.number().int(),
    action: Action,
    source: z.enum(["ADMIN", "LOCAL"]),
    state: State,
    createdAt: Time,
    deadline: Time,
    ackDeadline: Time,
    payload: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()).nullable(),
    actorId: Id,
    clientId: Id,
});
export const UpgradeInput = z.strictObject({ releaseId: Id.optional() });
export const WifiNetwork = z.strictObject({
    ssid: z.string().refine((v) => new TextEncoder().encode(v).byteLength <= 32),
    rssiDbm: z.number().int().min(-127).max(0),
    channel: z.number().int().min(1).max(233),
    band: z.enum(["2.4_GHZ", "5_GHZ", "6_GHZ"]),
    authMode: z.enum([
        "OPEN",
        "WEP",
        "WPA_PSK",
        "WPA2_PSK",
        "WPA_WPA2_PSK",
        "WPA2_ENTERPRISE",
        "WPA3_PSK",
        "WPA2_WPA3_PSK",
        "OWE",
        "UNKNOWN",
    ]),
});
export const WifiScan = z.strictObject({
    scannedAtMs: Time,
    wifiNetworks: z.array(WifiNetwork).max(40),
});
export const Result = z.strictObject({
    success: z.boolean(),
    reason: Id.optional(),
    bootId: Id.optional(),
    revision: z.number().int().positive().optional(),
    buildId: Id.optional(),
    healthy: z.boolean().optional(),
    syncedAtMs: Time.optional(),
    wifiCleared: z.boolean().optional(),
    runtimeConfigVersion: z.literal(1).optional(),
    wifiSsid: z.string().max(32).optional(),
    scannedAtMs: Time.optional(),
    wifiNetworks: z.array(WifiNetwork).max(40).optional(),
});
export const TimeReport = z.strictObject({
    server: z.string().min(1).max(253),
    configRevision: z.number().int().positive(),
    deviceTimeMs: Time,
    syncedAtMs: Time.nullable(),
    status: z.enum(["SYNCED", "UNSYNCED", "ERROR"]),
});
export const Boot = z.strictObject({
    bootId: Id,
    keyId: PublicKey,
    hardwareTarget: Id,
    firmwareVersion: z.string().min(1).max(100),
    buildId: Id,
    otaSlotBytes: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
    capabilities: z.array(Action).max(Action.options.length),
    appliedRevision: z.number().int().nonnegative(),
    healthy: z.boolean(),
    runtimeConfigVersion: z.literal(1).optional(),
    wifiSsid: z.string().max(32).optional(),
    time: TimeReport.optional(),
});
export const RotationProof = z.strictObject({ publicKey: DevicePublicKey, nonce: B64, proof: Signature });
const base = { version: z.literal(1), eventId: Id };
const op = { ...base, operationId: Id };
export const DeviceMessage = z.discriminatedUnion("type", [
    z.strictObject({ ...base, type: z.literal("BOOT_REPORT"), payload: Boot }),
    z.strictObject({
        ...base,
        type: z.literal("DEVICE_STATUS"),
        operationId: Id.optional(),
        payload: Boot,
    }),
    z.strictObject({ ...op, type: z.literal("COMMAND_ACK"), payload: z.strictObject({}) }),
    z.strictObject({
        ...op,
        type: z.literal("COMMAND_PROGRESS"),
        payload: z.strictObject({ progress: z.number().int().min(0).max(100) }),
    }),
    z.strictObject({ ...op, type: z.literal("COMMAND_RESULT"), payload: Result }),
    z.strictObject({ ...op, type: z.literal("KEY_PROPOSAL"), payload: RotationProof }),
    z.strictObject({ ...op, type: z.literal("KEY_ACTIVATED"), payload: RotationProof }),
    z.strictObject({
        ...base,
        type: z.literal("LOCAL_REQUEST"),
        payload: z.strictObject({ action: Action }),
    }),
]);
export const ServerMessage = z.discriminatedUnion("type", [
    z.strictObject({
        ...base,
        type: z.literal("WELCOME"),
        payload: z.strictObject({
            sessionId: Id,
            generation: z.number().int(),
            serverTimeMs: Time,
        }),
    }),
    z.strictObject({
        ...op,
        type: z.literal("COMMAND"),
        payload: z.strictObject({
            action: Action,
            deadline: Time,
            parameters: z.record(z.string(), z.unknown()),
        }),
    }),
    z.strictObject({
        ...base,
        type: z.literal("EVENT_ACK"),
        payload: z.strictObject({ eventId: Id }),
    }),
    z.strictObject({ ...base, type: z.literal("ERROR"), payload: z.strictObject({ code: Id }) }),
    z.strictObject({
        ...op,
        type: z.literal("KEY_COMMIT"),
        payload: z.strictObject({ keyId: PublicKey, nonce: B64 }),
    }),
    z.strictObject({
        ...op,
        type: z.literal("KEY_CONFIRMED"),
        payload: z.strictObject({ keyId: PublicKey }),
    }),
]);
export const Manifest = z.strictObject({
    releaseId: Id,
    buildId: Id,
    hardwareTarget: Id,
    version: z.string().min(1).max(100),
    size: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    publisherKeyId: PublicKey,
    signature: Signature,
});
export const Release = Manifest.extend({
    state: z.enum(["UPLOADING", "DRAFT", "APPROVED", "REVOKED"]),
    verified: z.boolean(),
    createdAt: Time,
});
export const ReleasePatch = z.strictObject({ state: z.enum(["APPROVED", "REVOKED"]) });
export const TargetInput = z.strictObject({ releaseId: Id });
export const RevokeKeyInput = z.strictObject({ keyId: PublicKey });
export const Empty = z.strictObject({});
export const Ok = z.strictObject({ ok: z.literal(true) });
export const ErrorBody = z.object({
    error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});
export const PageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: Id.optional(),
});
export const pageOf = <T extends z.ZodType>(item: T) =>
    z.strictObject({ items: z.array(item), nextCursor: Id.nullable() });
export const Audit = z.strictObject({
    eventId: Id,
    deviceId: Id.nullable(),
    siteId: Id.nullable(),
    scopeId: Id.nullable(),
    clientId: Id,
    actorId: Id,
    action: z.string(),
    createdAt: Time,
    detail: z.string(),
});
export const deadlines: Record<z.infer<typeof Action>, number> = {
    REQUEST_STATUS: 15_000,
    SYNC_TIME: 60_000,
    APPLY_CONFIG: 60_000,
    REBOOT: 120_000,
    RESET_WIFI: 120_000,
    SCAN_WIFI: 30_000,
    ROTATE_QR_KEY: 120_000,
    UPGRADE_FIRMWARE: 600_000,
};
export const finalStates = ["SUCCEEDED", "FAILED", "EXPIRED"] as const;
