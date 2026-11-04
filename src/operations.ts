import type { z } from "@hono/zod-openapi";
import type { Result, Operation } from "./contracts";
import type { DeviceRow, OperationRow } from "./platform";
import { ApiError } from "./platform";

export function resultState(
    op: OperationRow,
    result: z.infer<typeof Result>,
    d: DeviceRow
): "SUCCEEDED" | "FAILED" {
    if (!result.success) return "FAILED";
    const p = JSON.parse(op.payload) as Record<string, unknown>;
    let evidence = false;
    switch (op.action) {
        case "REQUEST_STATUS":
            evidence = true;
            break;
        case "SYNC_TIME":
            evidence = result.syncedAtMs !== undefined;
            break;
        case "APPLY_CONFIG":
            evidence =
                result.revision === p.revision &&
                (p.runtimeConfigVersion !== 1 ||
                    (result.runtimeConfigVersion === 1 && result.wifiSsid === p.wifiSsid));
            break;
        case "REBOOT":
            evidence = Boolean(
                result.bootId && result.bootId !== p.previousBootId && result.bootId === d.bootId
            );
            break;
        case "RESET_WIFI":
            evidence = result.wifiCleared === true;
            break;
        case "SCAN_WIFI":
            evidence = result.scannedAtMs !== undefined && result.wifiNetworks !== undefined;
            break;
        case "UPGRADE_FIRMWARE":
            evidence =
                result.buildId === p.buildId &&
                d.buildId === p.buildId &&
                result.bootId === d.bootId &&
                result.bootId !== p.previousBootId &&
                result.healthy === true &&
                d.reportedHealthy === 1;
            break;
        case "ROTATE_QR_KEY":
            evidence = false;
            break;
    }
    if (!evidence) throw new ApiError(409, "RESULT_EVIDENCE_REQUIRED");
    return "SUCCEEDED";
}
export function advance(state: z.infer<typeof Operation>["state"], kind: "ACK" | "PROGRESS") {
    if (["SUCCEEDED", "FAILED", "EXPIRED", "UNKNOWN"].includes(state)) return state;
    if (state === "CREATED") throw new ApiError(409, "RESULT_CONFLICT");
    return kind === "PROGRESS" || state === "RUNNING" ? "RUNNING" : "ACKNOWLEDGED";
}
