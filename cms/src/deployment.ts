import { z } from "zod";
import * as S from "../../src/contracts";
import { ApiFailure } from "./client";
export const DeploymentItem = z.strictObject({
    deviceId: S.Id,
    name: z.string(),
    targetKey: S.Id,
    key: S.Id,
    phase: z.enum(["READY", "ASSIGNING", "ASSIGNED", "DISPATCHING", "SENT"]),
    operationId: S.Id.nullable(),
    error: z.string(),
});
export type DeploymentItem = z.infer<typeof DeploymentItem>;
type Call = (
    path: string,
    method?: string,
    body?: unknown,
    schema?: z.ZodType,
    key?: string
) => Promise<unknown>;
export async function resumeDeployment(
    releaseId: string,
    item: DeploymentItem,
    call: Call,
    save: (item: DeploymentItem) => void,
    assignOnly = false,
    active = () => true
): Promise<DeploymentItem> {
    const update = (patch: Partial<DeploymentItem>) => {
        item = { ...item, ...patch };
        save(item);
    };
    const path = "/devices/" + item.deviceId;
    try {
        if (item.phase === "SENT") return item;
        if (item.phase === "DISPATCHING") {
            const found = (await call(
                path + "/operations?intentKey=" + item.key,
                "GET",
                undefined,
                S.pageOf(S.Operation)
            )) as { items: { operationId: string }[] };
            if (found.items[0])
                update({ phase: "SENT", operationId: found.items[0].operationId, error: "" });
            else
                update({
                    error: "Chưa tìm thấy kết quả. Chỉ đối chiếu lại; không tự gửi lại cập nhật.",
                });
            return item;
        }
        if (item.phase !== "ASSIGNED") {
            update({ phase: "ASSIGNING", error: "" });
            await call(
                path + "/firmware-target",
                "PUT",
                { releaseId },
                S.TargetInput,
                item.targetKey
            );
            update({ phase: "ASSIGNED" });
        }
        if (assignOnly || !active()) return item;
        update({ phase: "DISPATCHING", error: "" });
        const result = (await call(
            path + "/upgrades",
            "POST",
            { releaseId },
            S.Operation,
            item.key
        )) as { operationId: string };
        update({ phase: "SENT", operationId: result.operationId });
    } catch (e) {
        update({
            error: e instanceof ApiFailure ? e.code : "Mất phản hồi; cần đối chiếu.",
            ...(item.phase === "DISPATCHING" &&
            e instanceof ApiFailure &&
            e.status >= 400 &&
            e.status < 500
                ? { phase: "ASSIGNED" as const }
                : {}),
        });
    }
    return item;
}
