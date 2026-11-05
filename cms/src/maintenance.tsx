import * as R from "../../src/runtime-contracts";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import * as S from "../../src/contracts";
import * as C from "../../src/cms-contracts";
import { ApiFailure, operationLabel, readIntent, saveIntent, pollInterval } from "./client";
import {
    Confirm,
    Field,
    PageButtons,
    Problem,
    ReadState,
    Stamp,
    useModule,
    useRead,
    useRefresh,
} from "./shared";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog";
import { NetworkConfigPanel } from "./runtime-settings";
import { DeviceFirmwarePanel } from "./firmware";
const actionNames: Record<string, string> = {
    REQUEST_STATUS: "Lấy trạng thái mới",
    SCAN_WIFI: "Quét Wi-Fi",
    SYNC_TIME: "Đồng bộ giờ",
    APPLY_CONFIG: "Áp dụng cấu hình",
    REBOOT: "Khởi động lại",
    RESET_WIFI: "Xóa cấu hình Wi-Fi",
    ROTATE_QR_KEY: "Đổi khóa QR",
    UPGRADE_FIRMWARE: "Nâng cấp firmware",
    REVOKE_CREDENTIAL: "Ngắt quyền kết nối",
    REVOKE_KEY: "Thu hồi khóa QR",
};
export function Maintenance({ data }: { data: z.infer<typeof C.Overview> }) {
    const { api } = useModule(),
        refresh = useRefresh(),
        device = data.device,
        path = "/devices/" + device.deviceId;
    const [selected, setSelected] = useState<string | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState<unknown>(),
        [intent, setIntent] = useState(() => readIntent(device.deviceId)),
        [found, setFound] = useState<z.infer<typeof S.Operation> | null>(null),
        [showResult, setShowResult] = useState(false),
        [notice, setNotice] = useState("");
    const lock = useRef(false),
        attempt = useRef<{ action: string; key: string } | null>(null);
    const runtime = useRead(path + "/runtime-settings", R.RuntimeSettings);
    async function reconcile() {
        if (!intent) return;
        try {
            const page = await api.call(
                path + "/operations?intentKey=" + intent.key,
                "GET",
                undefined,
                S.pageOf(S.Operation)
            );
            setFound(page.items[0] ?? null);
            await refresh();
        } catch (e) {
            setError(e);
        }
    }
    useEffect(() => {
        void reconcile();
    }, [intent?.key]);
    function reason(action: string) {
        if (data.connection.state !== "ONLINE") return "Máy chưa online tại lần kiểm tra.";
        if (!device.capabilities.includes(action)) return "Firmware chưa hỗ trợ chức năng này.";
        if (action !== "REQUEST_STATUS" && data.activeOperation)
            return "Máy có thao tác đang chạy hoặc chưa rõ kết quả. Hãy đối chiếu trước.";
        if (
            action === "APPLY_CONFIG" &&
            runtime.data?.network.ssid &&
            runtime.data.status?.runtimeConfigVersion !== 1
        )
            return "Firmware chưa hỗ trợ thay Wi-Fi từ CMS.";
        return "";
    }
    async function dispatch() {
        if (!selected || lock.current) return;
        lock.current = true;
        setBusy(true);
        setError(undefined);
        setNotice("");
        const action = selected;
        if (attempt.current?.action !== action)
            attempt.current = { action, key: crypto.randomUUID() };
        const key = attempt.current.key;
        try {
            let endpoint = path + "/commands",
                method = "POST",
                body: unknown = { action };
            if (action === "REVOKE_CREDENTIAL") {
                endpoint = path + "/credential";
                method = "DELETE";
                body = undefined;
            }
            if (action === "REVOKE_KEY") {
                endpoint = path + "/key-revocations";
                body = { keyId: data.activeKeyId };
            }
            if (!action.startsWith("REVOKE")) {
                saveIntent(device.deviceId, key);
                setIntent({ deviceId: device.deviceId, key });
            }
            const result = await api.call(
                endpoint,
                method,
                body,
                z.union([S.Ok, S.Operation]),
                key
            );
            if ("operationId" in result) {
                setFound(result);
                setShowResult(true);
            } else setNotice("Đã thực hiện " + actionNames[action]!.toLowerCase() + ".");
            attempt.current = null;
            setSelected(null);
            await refresh();
        } catch (e) {
            setError(e);
            if (e instanceof ApiFailure && e.status > 0 && e.status < 500) attempt.current = null;
        } finally {
            setBusy(false);
            lock.current = false;
        }
    }
    function actions(items: string[]) {
        return items.map((a) => (
            <div key={a}>
                <Button variant="outline" disabled={!!reason(a)} onClick={() => setSelected(a)}>
                    {actionNames[a]}
                </Button>
                {reason(a) && <small>{reason(a)}</small>}
            </div>
        ));
    }
    return (
        <>
            <NetworkConfigPanel
                deviceId={device.deviceId}
                onApply={() => setSelected("APPLY_CONFIG")}
                disabledReason={reason("APPLY_CONFIG")}
                scanSupported={device.capabilities.includes("SCAN_WIFI")}
                scanDisabledReason={reason("SCAN_WIFI")}
            />
            <section>
                <h2>Trạng thái và khởi động</h2>
                <p>Đọc lại thông tin máy hoặc khởi động lại chương trình đang chạy.</p>
                <div className="actions">{actions(["REQUEST_STATUS", "REBOOT"])}</div>
            </section>
            <DeviceFirmwarePanel data={data} />
            <section>
                <h2>Bảo trì nâng cao</h2>
                <p>Các thao tác có thể làm máy mất kết nối hoặc ngừng xác minh check-in.</p>
                <div className="actions">
                    {actions(["RESET_WIFI", "ROTATE_QR_KEY"])}
                    {["REVOKE_CREDENTIAL", "REVOKE_KEY"].map((a) => (
                        <Button
                            variant="destructive"
                            key={a}
                            disabled={
                                a === "REVOKE_KEY" && !data.activeKeyId
                            }
                            onClick={() => setSelected(a)}
                        >
                            {actionNames[a]}
                        </Button>
                    ))}
                </div>
            </section>
            {!!error && <Problem error={error} />} {notice && <p role="status">{notice}</p>}
            {intent && (
                <div className="actions">
                    <Button
                        variant="outline"
                        onClick={() => {
                            void reconcile();
                            setShowResult(true);
                        }}
                    >
                        Xem thao tác đang theo dõi
                    </Button>
                </div>
            )}
            <Confirm
                open={!!selected}
                title={actionNames[selected ?? ""] ?? "Xác nhận"}
                description={
                    device.name +
                    " · " +
                    device.deviceId +
                    ". " +
                    (selected === "RESET_WIFI"
                        ? "Xóa mạng đã lưu. Máy có thể mất kết nối và cần thiết lập Wi-Fi tại chỗ."
                        : selected === "APPLY_CONFIG"
                          ? "Máy sẽ nhận cấu hình đã lưu. Thay Wi-Fi chỉ hoàn tất khi máy báo kết quả kết nối mạng mới."
                          : selected?.startsWith("REVOKE")
                            ? "Thu hồi có hiệu lực ngay; có thể cần ghép nối lại."
                            : "Yêu cầu đã gửi tiếp tục chạy khi đóng màn hình.")
                }
                busy={busy}
                onClose={() => setSelected(null)}
                onConfirm={() => void dispatch()}
            />
            <OperationDialog
                deviceId={device.deviceId}
                operation={found}
                open={showResult}
                onClose={() => setShowResult(false)}
            />
        </>
    );
}
export function OperationDialog({
    deviceId,
    operation,
    open,
    onClose,
}: {
    deviceId: string;
    operation: z.infer<typeof S.Operation> | null;
    open: boolean;
    onClose: () => void;
}) {
    const { portal } = useModule(),
        [state, setState] = useState(operation?.state ?? "CREATED");
    const query = useRead(
        "/devices/" + deviceId + "/operations/" + (operation?.operationId ?? ""),
        S.Operation,
        pollInterval(state),
        open && !!operation
    );
    useEffect(() => {
        setState(operation?.state ?? "CREATED");
    }, [operation?.operationId]);
    useEffect(() => {
        if (query.data) setState(query.data.state);
    }, [query.data?.state]);
    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                if (!v) onClose();
            }}
        >
            <DialogContent container={portal} showCloseButton={false}>
                <DialogTitle>Kết quả thao tác</DialogTitle>
                <DialogDescription>
                    Đóng cửa sổ không hủy yêu cầu đã gửi. Toàn bộ thao tác được lưu trong Lịch sử.
                </DialogDescription>
                {operation ? (
                    <ReadState query={query}>
                        <OperationRow operation={query.data ?? operation} />
                    </ReadState>
                ) : (
                    <p>Đang đối chiếu yêu cầu. Chưa có kết quả không có nghĩa là đã thất bại.</p>
                )}
                <Button variant="outline" onClick={onClose}>
                    Đóng
                </Button>
            </DialogContent>
        </Dialog>
    );
}
export function OperationRow({
    operation: o,
    percent,
}: {
    operation: z.infer<typeof S.Operation>;
    percent?: number;
}) {
    return (
        <article className="operation">
            <strong>
                {actionNames[o.action]} — {operationLabel(o.state)}
            </strong>
            <code>{o.operationId}</code>
            <small>
                {o.source === "LOCAL" ? "Thiết bị khởi phát" : "Quản trị"} ·{" "}
                <Stamp value={o.createdAt} />
            </small>
            {percent !== undefined && <p>Tiến độ máy báo: {percent}%</p>}
            {!!o.result?.reason && (
                <p>
                    {o.result.reason === "ROLLED_BACK"
                        ? "Thiết bị đã quay lại firmware trước (ROLLED_BACK)."
                        : o.result.reason === "NO_CHANGE"
                          ? "Cấu hình trên máy đã đúng, không cần thay đổi."
                          : "Lý do: " + String(o.result.reason)}
                </p>
            )}
            {!!o.result?.buildId && <p>Build thực tế: {String(o.result.buildId)}</p>}
            {o.state === "UNKNOWN" && (
                <p>Cần đối chiếu kết quả trước khi gửi lệnh thay đổi khác.</p>
            )}
        </article>
    );
}
export function OperationTable({ deviceId }: { deviceId: string }) {
    const [pages, setPages] = useState<string[]>([]),
        [state, setState] = useState(""),
        [action, setAction] = useState(""),
        params = new URLSearchParams();
    if (pages.at(-1)) params.set("cursor", pages.at(-1)!);
    if (state) params.set("state", state);
    if (action) params.set("action", action);
    const query = useRead("/devices/" + deviceId + "/operations?" + params, S.pageOf(S.Operation));
    return (
        <section>
            <h2>Lịch sử thao tác</h2>
            <div className="filters">
                <Field label="Trạng thái thao tác">
                    <select
                        value={state}
                        onChange={(e) => {
                            setPages([]);
                            setState(e.target.value);
                        }}
                    >
                        <option value="">Tất cả</option>
                        {S.State.options.map((s) => (
                            <option value={s} key={s}>
                                {operationLabel(s)}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Loại thao tác">
                    <select
                        value={action}
                        onChange={(e) => {
                            setPages([]);
                            setAction(e.target.value);
                        }}
                    >
                        <option value="">Tất cả</option>
                        {S.Action.options.map((s) => (
                            <option value={s} key={s}>
                                {actionNames[s]}
                            </option>
                        ))}
                    </select>
                </Field>
            </div>
            <ReadState query={query}>
                {query.data?.items.map((o) => (
                    <OperationRow key={o.operationId} operation={o} />
                ))}
                {query.data && !query.data.items.length && <p>Chưa có thao tác phù hợp.</p>}
                <PageButtons
                    next={query.data?.nextCursor ?? null}
                    previous={pages.length > 0}
                    onNext={() => setPages([...pages, query.data!.nextCursor!])}
                    onPrevious={() => setPages((p) => p.slice(0, -1))}
                />
            </ReadState>
        </section>
    );
}
