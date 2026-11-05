import { z } from "@hono/zod-openapi";
import { Id, PublicKey, DevicePublicKey, Signature, Time } from "./contracts";

export const RegistrationState = z.enum([
    "CHALLENGE",
    "COMPLETED",
    "LOCKED",
    "EXPIRED",
]);
export const RegistrationInput = z.strictObject({
    publicKey: DevicePublicKey,
    hardwareTarget: Id,
    serial: z.string().min(1).max(100).optional(),
});
export const RegistrationChallenge = z.strictObject({
    registrationId: Id,
    nonce: PublicKey,
    expiresAt: Time,
});
export const RegistrationProof = z.strictObject({ nonce: PublicKey, proof: Signature });
export const RegistrationMeta = z.strictObject({
    registrationId: Id,
    deviceId: Id.nullable(),
    hardwareTarget: Id,
    serial: z.string().nullable(),
    publicKey: DevicePublicKey,
    keyId: PublicKey,
    state: RegistrationState,
    createdAt: Time,
    expiresAt: Time,
});
export const RegistrationQuery = z.strictObject({
    state: z
        .enum(["ALL", ...RegistrationState.options])
        .default("ALL"),
    cursor: Id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const registrationBytes = (
    registration: { registrationId: string; nonce: string; keyId: string }
) =>
    `REGISTER_V1|${registration.registrationId}|${registration.nonce}|${registration.keyId}`;
