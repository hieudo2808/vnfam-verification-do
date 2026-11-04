import { Unzip, UnzipInflate } from "fflate";
import valid from "semver/functions/valid";
import * as S from "../../src/contracts";
import { ApiFailure } from "./client";
export async function validateArtifact(manifest: unknown, file: File) {
    const m = S.Manifest.parse(manifest);
    if (!valid(m.version)) throw new ApiFailure("INVALID_VERSION");
    if (file.size !== m.size || file.size > 8 * 1024 * 1024)
        throw new ApiFailure("ARTIFACT_SIZE_MISMATCH");
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const hex = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
    if (hex !== m.sha256) throw new ApiFailure("ARTIFACT_HASH_MISMATCH");
    return m;
}
export async function readFirmwarePackage(input: Pick<File, "size" | "arrayBuffer">) {
    if (input.size > 9 * 1024 * 1024) throw new ApiFailure("PAYLOAD_TOO_LARGE");
    const files = new Map<string, Uint8Array>(),
        seen = new Set<string>();
    const unzip = new Unzip((file) => {
        if (!["manifest.json", "application.bin"].includes(file.name) || seen.has(file.name))
            throw new ApiFailure("FIRMWARE_PACKAGE_INVALID");
        seen.add(file.name);
        const limit = file.name === "manifest.json" ? 65536 : 8 * 1024 * 1024;
        if (file.originalSize !== undefined && file.originalSize > limit)
            throw new ApiFailure("PAYLOAD_TOO_LARGE");
        const parts: Uint8Array[] = [];
        let length = 0;
        file.ondata = (error, chunk, final) => {
            if (error) throw new ApiFailure("FIRMWARE_PACKAGE_INVALID");
            length += chunk.length;
            if (length > limit) {
                file.terminate();
                throw new ApiFailure("PAYLOAD_TOO_LARGE");
            }
            parts.push(chunk);
            if (final) {
                const content = new Uint8Array(length);
                let offset = 0;
                for (const part of parts) {
                    content.set(part, offset);
                    offset += part.length;
                }
                files.set(file.name, content);
            }
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    try {
        const content = new Uint8Array(await input.arrayBuffer());
        for (let offset = 0; offset < content.length; offset += 1024)
            unzip.push(content.subarray(offset, offset + 1024), offset + 1024 >= content.length);
        if (files.size !== 2) throw new Error();
        const file = new File(
            [new Uint8Array(files.get("application.bin")!).buffer],
            "application.bin",
            { type: "application/octet-stream" }
        );
        const manifest = await validateArtifact(
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(files.get("manifest.json"))
            ),
            file
        );
        return { manifest, file };
    } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure("FIRMWARE_PACKAGE_INVALID");
    }
}
