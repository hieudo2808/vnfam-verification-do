import { Api, ApiFailure } from "./client";
import * as S from "../../src/contracts";
import type { readFirmwarePackage } from "./firmware-package";
export type FirmwarePackage = Awaited<ReturnType<typeof readFirmwarePackage>>;
export async function prepareFirmware(
    api: Api,
    artifact: FirmwarePackage,
    intent: { createKey: string; approveKey: string },
    upload: (url: string, file: File) => Promise<void>,
    phase: (value: string) => void
) {
    const { manifest, file } = artifact,
        path = "/firmware-releases/" + manifest.releaseId;
    phase("Đang kiểm tra firmware…");
    let current;
    try {
        current = await api.call(path, "GET", undefined, S.Release);
    } catch (error) {
        if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
        current = await api.call(
            "/firmware-releases",
            "POST",
            manifest,
            S.Release,
            intent.createKey
        );
    }
    for (const field of Object.keys(S.Manifest.shape) as (keyof typeof manifest)[])
        if (current[field] !== manifest[field]) throw new ApiFailure("ARTIFACT_CONFLICT");
    if (current.state === "REVOKED") throw new ApiFailure("RELEASE_REVOKED");
    if (!current.verified) {
        phase("Đang tải firmware…");
        await upload(api.base + path + "/binary", file);
        current = await api.call(path, "GET", undefined, S.Release);
    }
    if (!current.verified) throw new ApiFailure("ARTIFACT_NOT_VERIFIED");
    if (current.state === "DRAFT") {
        phase("Đang chuẩn bị cập nhật…");
        current = await api.call(
            path,
            "PATCH",
            { state: "APPROVED" },
            S.Release,
            intent.approveKey
        );
    }
    if (current.state !== "APPROVED") throw new ApiFailure("RELEASE_NOT_APPROVED");
    return current;
}
