import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import * as S from "../../src/contracts";
import * as C from "../../src/cms-contracts";
import {
    Confirm,
    Field,
    PageButtons,
    Problem,
    ReadState,
    useModule,
    useRead,
    useRefresh,
} from "./shared";
import { Button } from "./components/ui/button";
import { DeploymentItem, resumeDeployment } from "./deployment";
import { targetReason } from "./compatibility";
import { operationLabel, pollInterval } from "./client";
import { OperationDialog } from "./maintenance";

export function FirmwareDeployment({ release }: { release: z.infer<typeof S.Release> }) {
    const storage = "vnfam:deployment:" + release.releaseId,
        { api } = useModule(),
        refresh = useRefresh();
    const [q, setQ] = useState(""),
        [pages, setPages] = useState<string[]>([]),
        [items, setItems] = useState<DeploymentItem[]>(() => {
            try {
                return z
                    .array(DeploymentItem)
                    .parse(JSON.parse(sessionStorage.getItem(storage) ?? "[]"));
            } catch {
                return [];
            }
        }),
        [selected, setSelected] = useState<Record<string, string>>(() =>
            Object.fromEntries(
                items.filter((i) => i.phase !== "SENT").map((i) => [i.deviceId, i.name])
            )
        ),
        [busy, setBusy] = useState(false),
        [mode, setMode] = useState<"assign" | "upgrade" | null>(null),
        [error, setError] = useState<unknown>();
    const lock = useRef(false),
        current = useRef(items),
        active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    const query = useRead(
        "/device-summaries?q=" +
            encodeURIComponent(q) +
            (pages.at(-1) ? "&cursor=" + pages.at(-1) : ""),
        S.pageOf(C.Summary)
    );
    function persist(next: DeploymentItem[]) {
        sessionStorage.setItem(storage, JSON.stringify(next));
        current.current = next;
        setItems(next);
    }
    async function run(assignOnly: boolean, reconcileOnly = false) {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError(undefined);
        try {
            const next = [...current.current];
            if (!reconcileOnly)
                for (const [deviceId, name] of Object.entries(selected))
                    if (!next.some((i) => i.deviceId === deviceId))
                        next.push({
                            deviceId,
                            name,
                            targetKey: crypto.randomUUID(),
                            key: crypto.randomUUID(),
                            phase: "READY",
                            operationId: null,
                            error: "",
                        });
            persist(next);
            // Closing the page leaves unsent entries for explicit resume; dispatching entries are only reconciled.
            for (const item of [...current.current]) {
                if (!active.current) break;
                if (reconcileOnly && item.phase !== "DISPATCHING") continue;
                if (!reconcileOnly && !selected[item.deviceId]) continue;
                await resumeDeployment(
                    release.releaseId,
                    item,
                    api.call.bind(api),
                    (updated) =>
                        persist(
                            current.current.map((i) =>
                                i.deviceId === updated.deviceId ? updated : i
                            )
                        ),
                    assignOnly,
                    () => active.current
                );
            }
            setMode(null);
            await refresh();
        } catch (e) {
            setError(e);
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }
    const eligible = (s: z.infer<typeof C.Summary>) =>
        targetReason(s.device, release) ||
        (s.connection.state !== "ONLINE"
            ? "Chưa xác minh máy online."
            : s.activeOperation
              ? "Đang có thao tác chưa hoàn tất."
              : "");
    const candidates = Object.entries(selected).filter(
            ([id]) => !items.some((i) => i.deviceId === id && i.phase === "SENT")
        ),
        count = candidates.length;
    return (
        <section>
            <h2>Cập nhật thiết bị</h2>
            <Field label="Tìm thiết bị cập nhật">
                <input
                    value={q}
                    onChange={(e) => {
                        setQ(e.target.value);
                        setPages([]);
                    }}
                />
            </Field>
            <ReadState query={query}>
                <div className="table-wrap">
                    <table>
                        <caption>Thiết bị nhận firmware {release.version}</caption>
                        <thead>
                            <tr>
                                <th>Chọn</th>
                                <th>Tên / mã máy</th>
                                <th>Firmware hiện tại</th>
                                <th>Khả năng cập nhật</th>
                            </tr>
                        </thead>
                        <tbody>
                            {query.data?.items.map((s) => {
                                const reason = eligible(s);
                                return (
                                    <tr key={s.device.deviceId}>
                                        <td>
                                            <input
                                                type="checkbox"
                                                aria-label={
                                                    "Chọn " +
                                                    s.device.name +
                                                    " · " +
                                                    s.device.deviceId
                                                }
                                                disabled={
                                                    busy ||
                                                    items.some(
                                                        (i) =>
                                                            i.deviceId === s.device.deviceId &&
                                                            i.phase === "SENT"
                                                    ) ||
                                                    (!!reason && !selected[s.device.deviceId])
                                                }
                                                checked={!!selected[s.device.deviceId]}
                                                onChange={(e) =>
                                                    setSelected((old) => {
                                                        const value = { ...old };
                                                        if (e.target.checked)
                                                            value[s.device.deviceId] =
                                                                s.device.name;
                                                        else delete value[s.device.deviceId];
                                                        return value;
                                                    })
                                                }
                                            />
                                        </td>
                                        <td>
                                            {s.device.name}
                                            <code>{s.device.deviceId}</code>
                                        </td>
                                        <td>{s.device.firmwareVersion ?? "Chưa có BOOT"}</td>
                                        <td>{reason || "Có thể cập nhật"}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <PageButtons
                    next={query.data?.nextCursor ?? null}
                    previous={pages.length > 0}
                    onNext={() => setPages([...pages, query.data!.nextCursor!])}
                    onPrevious={() => setPages((p) => p.slice(0, -1))}
                />
            </ReadState>
            <div className="actions">
                <Button disabled={!count || busy} onClick={() => setMode("upgrade")}>
                    Cập nhật thiết bị đã chọn ({count})
                </Button>
                <Button
                    variant="outline"
                    disabled={!count || busy}
                    onClick={() => setMode("assign")}
                >
                    Chỉ gán bản cập nhật
                </Button>
                {!!items.length && (
                    <Button variant="outline" disabled={busy} onClick={() => void run(true, true)}>
                        Đối chiếu tiến trình
                    </Button>
                )}
            </div>
            {items.map((item) => (
                <div className="operation" key={item.deviceId}>
                    <strong>{item.name}</strong>
                    <code>{item.deviceId}</code>
                    {item.operationId ? (
                        <DeploymentResult deviceId={item.deviceId} operationId={item.operationId} />
                    ) : (
                        <p>
                            {item.phase === "ASSIGNED"
                                ? "Đã gán; chưa gửi lệnh cập nhật."
                                : item.phase === "DISPATCHING"
                                  ? "Chưa xác định yêu cầu đã được nhận."
                                  : item.phase === "ASSIGNING"
                                    ? "Đang đối chiếu việc gán firmware."
                                    : "Chưa gửi."}
                        </p>
                    )}
                    {item.error && <p role="alert">{item.error}</p>}
                </div>
            ))}
            {!!error && <Problem error={error} />}
            <Confirm
                open={!!mode}
                title={mode === "assign" ? "Gán firmware" : "Cập nhật firmware"}
                description={
                    count +
                    " thiết bị: " +
                    candidates.map(([id, name]) => name + " · " + id).join(", ") +
                    (mode === "upgrade"
                        ? ". Các thiết bị sẽ khởi động lại để cập nhật."
                        : ". Lưu firmware để cập nhật từ nút tại thiết bị.")
                }
                busy={busy}
                onClose={() => setMode(null)}
                onConfirm={() => void run(mode === "assign")}
            />
        </section>
    );
}
function DeploymentResult({ deviceId, operationId }: { deviceId: string; operationId: string }) {
    const [state, setState] = useState("CREATED"),
        [open, setOpen] = useState(false),
        query = useRead(
            "/devices/" + deviceId + "/operations/" + operationId,
            S.Operation,
            pollInterval(state)
        );
    useEffect(() => {
        if (query.data) setState(query.data.state);
    }, [query.data?.state]);
    return (
        <>
            <ReadState query={query}>
                <p>
                    {operationLabel(query.data?.state ?? "CREATED")}
                    {query.data?.result?.reason ? " · " + String(query.data.result.reason) : ""}
                </p>
                <Button variant="outline" onClick={() => setOpen(true)}>
                    Xem kết quả
                </Button>
            </ReadState>
            <OperationDialog
                deviceId={deviceId}
                operation={query.data ?? null}
                open={open}
                onClose={() => setOpen(false)}
            />
        </>
    );
}
