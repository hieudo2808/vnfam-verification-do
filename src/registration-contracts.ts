import { z } from "@hono/zod-openapi";
import { Id, PublicKey, DevicePublicKey, Signature, Time } from "./contracts";

export const RegistrationState = z.enum([
    "CHALLENGE",
    "PENDING",
    "APPROVED",
    "CLAIMED",
    "REJECTED",
    "LOCKED",
    "EXPIRED",
]);
export const RegistrationInput = z.strictObject({
    publicKey: DevicePublicKey,
    hardwareTarget: Id,
    serial: z.string().min(1).max(100).optional(),
});
export const RegistrationSecret = PublicKey;
export const RegistrationChallenge = z.strictObject({
    registrationId: Id,
    nonce: RegistrationSecret,
    claimSecret: RegistrationSecret,
    expiresAt: Time,
});
export const RegistrationAccess = z.strictObject({ claimSecret: RegistrationSecret });
export const RegistrationProof = RegistrationAccess.extend({ proof: Signature });
export const RegistrationApproval = z.strictObject({ name: z.string().trim().min(1).max(200) });
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
        .enum(["PENDING", "APPROVED", "CLAIMED", "REJECTED", "LOCKED", "EXPIRED"])
        .default("PENDING"),
    cursor: Id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const registrationBytes = (
    phase: "SUBMIT" | "CLAIM",
    registration: { registrationId: string; nonce: string; keyId: string }
) =>
    `REGISTER_${phase}_V1|${registration.registrationId}|${registration.nonce}|${registration.keyId}`;
