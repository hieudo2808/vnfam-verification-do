import valid from "semver/functions/valid";
import gt from "semver/functions/gt";
import type { z } from "zod";
import type { Device, Release } from "../../src/contracts";
export function targetReason(d: z.infer<typeof Device>, r: z.infer<typeof Release>) {
    if (!d.hardwareTarget || !d.firmwareVersion || d.otaSlotBytes === null)
        return "Chờ BOOT khai báo hardware, phiên bản và slot.";
    if (r.state !== "APPROVED" || !r.verified) return "Release chưa được duyệt hoặc đã thu hồi.";
    if (d.hardwareTarget !== r.hardwareTarget) return "Hardware không khớp.";
    if (!d.capabilities.includes("UPGRADE_FIRMWARE")) return "Firmware chưa hỗ trợ OTA.";
    if (r.size > d.otaSlotBytes) return "File firmware vượt dung lượng cập nhật của máy.";
    if (!valid(d.firmwareVersion) || !valid(r.version) || !gt(r.version, d.firmwareVersion))
        return "Cần phiên bản mới hơn firmware hiện tại.";
    return "";
}
