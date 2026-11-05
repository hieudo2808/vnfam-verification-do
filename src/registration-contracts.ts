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
export const registrationBytes = (
    registration: { registrationId: string; nonce: string; keyId: string }
) =>
    `REGISTER_V1|${registration.registrationId}|${registration.nonce}|${registration.keyId}`;
