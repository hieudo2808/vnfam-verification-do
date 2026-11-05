import { z } from "zod";
import { unb64, verifyP256 } from "./crypto";

export const ContractQrQuery = z.strictObject({
    v: z.literal("1"),
    did: z.string().regex(/^[a-z0-9-]{1,32}$/),
    t: z.string()
        .regex(/^(0|[1-9][0-9]{0,9})$/)
        .refine((value) => {
            const seconds = Number(value);
            return Number.isSafeInteger(seconds * 1000) && seconds % 30 === 0;
        }),
    sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/).refine((value) => {
        try {
            return unb64(value).length === 64;
        } catch {
            return false;
        }
    }),
});
export type ContractQr = z.infer<typeof ContractQrQuery>;
export const contractQrBytes = (qr: ContractQr) => `v1.${qr.did}.${qr.t}`;

export async function verifyCheckinQr(
    qr: ContractQr,
    publicKey: string,
    policy: { maxAgeMs: number; futureSkewMs: number },
    nowMs: number
) {
    if (!(await verifyP256(publicKey, qr.sig, contractQrBytes(qr))))
        return { error: "invalid_signature" } as const;
    const issuedAtMs = Number(qr.t) * 1000,
        age = nowMs - issuedAtMs;
    if (age > policy.maxAgeMs) return { error: "expired" } as const;
    if (age < -policy.futureSkewMs) return { error: "bad_request" } as const;
    return { valid: true, deviceId: qr.did, issuedAtMs, verifiedAtMs: nowMs } as const;
}
