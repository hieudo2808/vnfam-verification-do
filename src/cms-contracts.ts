import { z } from "@hono/zod-openapi";
import * as S from "./contracts";
export const DeviceDefaults = S.DeviceInput.pick({ siteId: true, scopeId: true, qrBaseUrl: true });
export const Connection = z.strictObject({
    state: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]),
    observedAt: S.Time.nullable(),
});
export const Identity = z.enum(["UNPAIRED", "AWAITING_BOOT", "CONFIRMED", "REPAIR_REQUIRED"]);
export const Summary = z.strictObject({
    device: S.Device,
    identity: Identity,
    connection: Connection,
    activeOperation: S.Operation.nullable(),
});
export const Context = z.strictObject({
    clientId: S.Id,
    sites: z.array(S.Id),
    scopes: z.array(S.Id),
    permissions: z.array(S.Permissions),
    serverTimeMs: S.Time,
});
export const Progress = z.strictObject({
    percent: z.number().int().min(0).max(100),
    updatedAt: S.Time,
});
export const PairingMeta = z.strictObject({
    pairingId: S.Id,
    generation: z.number().int(),
    expiresAt: S.Time,
    attempts: z.number().int(),
    state: z.enum(["PENDING", "CONSUMED", "CANCELLED", "LOCKED", "EXPIRED"]),
});
export const KeyMeta = z.strictObject({
    keyId: S.PublicKey,
    publicKey: S.DevicePublicKey,
    generation: z.number().int(),
    state: z.enum(["ACTIVE", "PENDING", "REVOKED"]),
    createdAt: S.Time,
});
export const Overview = Summary.extend({
    config: S.Config,
    pairing: PairingMeta.nullable(),
    keys: z.array(KeyMeta),
    recentOperations: z.array(
        z.strictObject({ operation: S.Operation, progress: Progress.nullable() })
    ),
    lastSyncedAtMs: S.Time.nullable(),
    serverTimeMs: S.Time,
});
export const DeviceQuery = S.PageQuery.extend({
    q: z.string().max(200).optional(),
    siteId: S.Id.optional(),
    scopeId: S.Id.optional(),
    identity: Identity.optional(),
    accepting: z.enum(["true", "false"]).optional(),
    connection: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]).optional(),
});
export const HistoryQuery = S.PageQuery.extend({
    deviceName: z.string().max(200).optional(),
    subjectName: z.string().max(200).optional(),
    deviceId: S.Id.optional(),
    subjectId: S.Id.optional(),
    siteId: S.Id.optional(),
    scopeId: S.Id.optional(),
    action: z.string().max(100).optional(),
    fromMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    toMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const CheckInSummary = S.Receipt.extend({
    subjectName: S.DisplayName.nullable(),
    scopeName: S.DisplayName.nullable(),
    deviceName: S.Device.shape.name.nullable(),
});
export const AuditSummary = S.Audit.extend({
    actorName: z.string().nullable(),
    deviceName: S.Device.shape.name.nullable(),
    operationAction: S.Action.nullable(),
    operationState: S.State.nullable(),
    firmwareVersion: z.string().nullable(),
    subjectName: S.DisplayName.nullable(),
});
export const ReleaseQuery = S.PageQuery.extend({
    hardwareTarget: S.Id.optional(),
    version: z.string().max(100).optional(),
    state: z.enum(["UPLOADING", "DRAFT", "APPROVED", "REVOKED"]).optional(),
});
export const OperationQuery = S.PageQuery.extend({
    intentKey: S.Id.optional(),
    action: S.Action.optional(),
    state: S.State.optional(),
    fromMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    toMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
