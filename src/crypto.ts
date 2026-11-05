const utf8 = new TextEncoder();
export const bytes = (text: string) => utf8.encode(text);
export function b64(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}
export function unb64(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
    const result = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
        c.charCodeAt(0)
    );
    if (b64(result) !== value) throw new Error("Noncanonical encoding");
    return result;
}
export const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
    return b64(
        new Uint8Array(
            await crypto.subtle.digest("SHA-256", typeof value === "string" ? bytes(value) : value)
        )
    );
}
export async function verify(
    publicKey: string,
    signature: string,
    message: string
): Promise<boolean> {
    try {
        const raw = unb64(publicKey),
            sig = unb64(signature);
        if (raw.length !== 32 || sig.length !== 64) return false;
        const key = await crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
        return await crypto.subtle.verify("Ed25519", key, sig, bytes(message));
    } catch {
        return false;
    }
}
export async function verifyP256(
    publicKey: string,
    signature: string,
    message: string
): Promise<boolean> {
    try {
        const raw = unb64(publicKey),
            sig = unb64(signature);
        if (raw.length !== 65 || raw[0] !== 4 || sig.length !== 64) return false;
        const key = await crypto.subtle.importKey(
            "raw",
            raw,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"]
        );
        return await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            key,
            sig,
            bytes(message)
        );
    } catch {
        return false;
    }
}
export const verifyDeviceSignature = (publicKey: string, signature: string, message: string) =>
    publicKey.length === 87
        ? verifyP256(publicKey, signature, message)
        : verify(publicKey, signature, message);
export const qrBytes = (q: {
    deviceId: string;
    scopeId: string;
    keyId: string;
    issuedAtMs: number;
}) => `CHECKIN_V1|${q.deviceId}|${q.scopeId}|${q.keyId}|${q.issuedAtMs}`;
export const pairingBytes = (
    p: { pairingId: string; deviceId: string; nonce: string },
    keyId: string
) => `PAIR_V1|${p.pairingId}|${p.deviceId}|${p.nonce}|${keyId}`;
export const rotationBytes = (
    phase: "PROPOSE" | "ACTIVATE",
    operationId: string,
    deviceId: string,
    generation: number,
    nonce: string,
    keyId: string
) => `ROTATE_${phase}_V1|${operationId}|${deviceId}|${generation}|${nonce}|${keyId}`;
export const manifestBytes = (m: {
    releaseId: string;
    buildId: string;
    hardwareTarget: string;
    version: string;
    size: number;
    sha256: string;
    publisherKeyId: string;
}) =>
    `FIRMWARE_V1|${m.releaseId}|${m.buildId}|${m.hardwareTarget}|${m.version}|${m.size}|${m.sha256}|${m.publisherKeyId}`;
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(",")}}`;
    return JSON.stringify(value);
}
