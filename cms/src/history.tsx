import { useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as S from "../../src/contracts";
import * as C from "../../src/cms-contracts";
import { operationLabel } from "./client";
import {
    Confirm,
    Field,
    PageButtons,
    Problem,
    ReadState,
    Stamp,
    BridgeContext,
    useModule,
    useRead,
    useRefresh,
} from "./shared";
import { Button } from "./components/ui/button";
import { useIntent } from "./intent";
export function HistoryTable({
    kind,
    deviceId,
}: {
    kind: "check-ins" | "audit-events";
    deviceId?: string;
}) {
    const [filters, setFilters] = useState<Record<string, string>>({}),
        [pages, setPages] = useState<string[]>([]);
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    if (deviceId) params.set("deviceId", deviceId);
    if (pages.at(-1)) params.set("cursor", pages.at(-1)!);
    const check = useRead(
            "/check-in-summaries?" + params,
            S.pageOf(C.CheckInSummary),
            15000,
            kind === "check-ins"
        ),
        audit = useRead(
            "/audit-summaries?" + params,
            S.pageOf(C.AuditSummary),
            15000,
            kind === "audit-events"
        ),
        query = kind === "check-ins" ? check : audit;
    const change = (key: string, value: string) => {
        setFilters({ ...filters, [key]: value });
        setPages([]);
    };
    return (
        <section>
            <h1>{kind === "check-ins" ? "Lịch sử check-in" : "Nhật ký quản trị"}</h1>
            <div className="filters">
                {!deviceId && (
                    <Field label="Tên thiết bị">
                        <input
                            value={filters.deviceName ?? ""}
                            onChange={(e) => change("deviceName", e.target.value)}
                        />
                    </Field>
                )}
                <Field label={kind === "check-ins" ? "Subject" : "Hành động"}>
                    {kind === "check-ins" ? (
                        <input
                            value={filters.subjectName ?? ""}
                            onChange={(e) => change("subjectName", e.target.value)}
                        />
                    ) : (
                        <select
                            value={filters.action ?? ""}
                            onChange={(e) => change("action", e.target.value)}
                        >
                            <option value="">Tất cả</option>
                            {Object.entries(auditLabels).map(([value, label]) => (
                                <option value={value} key={value}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    )}
                </Field>
                {[
                    ["fromMs", "Từ thời điểm"],
                    ["toMs", "Trước thời điểm"],
                ].map(([k, label]) => (
                    <Field key={k} label={label!}>
                        <input
                            type="datetime-local"
                            onChange={(e) =>
                                change(
                                    k!,
                                    e.target.value ? String(new Date(e.target.value).getTime()) : ""
                                )
                            }
                        />
                    </Field>
                ))}
            </div>
            <ReadState query={query}>
                {kind === "check-ins" ? (
                    <div className="table-wrap">
                        <table>
                            <caption className="sr-only">Lượt check-in đã xác nhận</caption>
                            <thead>
                                <tr>
                                    <th>Subject / Scope</th>
                                    <th>Thiết bị</th>
                                    <th>Thời điểm</th>
                                </tr>
                            </thead>
                            <tbody>
                                {check.data?.items.map((r) => (
                                    <tr key={r.checkInId}>
                                        <td>
                                            {r.subjectName ?? "Chưa có tên"}
                                            <small>{r.scopeName ?? "Chưa có tên"}</small>
                                            <details>
                                                <summary>Mã tra cứu</summary>
                                                <dl>
                                                    <dt>Mã xác nhận</dt>
                                                    <dd>
                                                        <code>{r.checkInId}</code>
                                                    </dd>
                                                    <dt>Mã đối tượng</dt>
                                                    <dd>
                                                        <code>{r.subjectId}</code>
                                                    </dd>
                                                    <dt>Mã phạm vi</dt>
                                                    <dd>
                                                        <code>{r.scopeId}</code>
                                                    </dd>
                                                </dl>
                                            </details>
                                        </td>
                                        <td>
                                            <Link relative="path" to={"../devices/" + r.deviceId}>
                                                {r.deviceName ?? "Thiết bị không còn trong phạm vi"}
                                            </Link>
                                        </td>
                                        <td>
                                            <Stamp value={r.verifiedAtMs} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="table-wrap">
                        <table>
                            <caption className="sr-only">Nhật ký hoạt động</caption>
                            <thead>
                                <tr>
                                    <th>Hành động</th>
                                    <th>Máy / Người thao tác</th>
                                    <th>Thời điểm</th>
                                    <th>Chi tiết</th>
                                </tr>
                            </thead>
                            <tbody>
                                {audit.data?.items.map((r) => (
                                    <tr key={r.eventId}>
                                        <td>{auditLabels[r.action] ?? "Hoạt động khác"}</td>
                                        <td>
                                            {r.deviceId ? (
                                                <Link
                                                    relative="path"
                                                    to={"../devices/" + r.deviceId}
                                                >
                                                    {r.deviceName ??
                                                        "Thiết bị không còn trong phạm vi"}
                                                </Link>
                                            ) : (
                                                "Toàn hệ thống"
                                            )}
                                            <small>
                                                {r.clientId === "device"
                                                    ? "Thiết bị khởi phát"
                                                    : (r.actorName ?? "Chưa có tên người thao tác")}
                                            </small>
                                        </td>
                                        <td>
                                            <Stamp value={r.createdAt} />
                                        </td>
                                        <td>
                                            <AuditDetail row={r} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {query.data && !query.data.items.length && <p>Chưa có bản ghi phù hợp.</p>}
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
const actionLabels: Record<string, string> = {
    REQUEST_STATUS: "Lấy trạng thái",
    SCAN_WIFI: "Quét Wi-Fi",
    SYNC_TIME: "Đồng bộ thời gian",
    APPLY_CONFIG: "Áp dụng cấu hình",
    REBOOT: "Khởi động lại",
    RESET_WIFI: "Xóa Wi-Fi",
    ROTATE_QR_KEY: "Đổi khóa QR",
    UPGRADE_FIRMWARE: "Cập nhật firmware",
};
const auditLabels: Record<string, string> = {
    DEVICE_CREATED: "Tạo hồ sơ thiết bị",
    DEVICE_DELETED: "Xóa thiết bị",
    DEVICE_UPDATED: "Cập nhật thiết bị",
    CONFIG_DESIRED: "Lưu cấu hình",
    NETWORK_CONFIG_SAVED: "Lưu Wi-Fi",
    TIME_SETTINGS_UPDATED: "Đổi cấu hình thời gian",
    PAIRING_CREATED: "Tạo yêu cầu ghép lại",
    PAIRING_CANCELLED: "Hủy ghép lại",
    PAIRING_COMPLETED: "Hoàn tất ghép nối",
    DEVICE_REGISTRATION_COMPLETED: "Thiết bị tự đăng ký và nhận quyền kết nối",
    CREDENTIAL_REVOKED: "Thu hồi quyền kết nối",
    QR_KEY_REVOKED: "Thu hồi khóa QR",
    CHECK_IN_ACCEPTED: "Xác nhận check-in",
    POLICY_CHANGED: "Đổi chính sách QR",
    RELEASE_CREATED: "Nhận firmware",
    RELEASE_UPLOADED: "Xác minh firmware",
    RELEASE_STATE_CHANGED: "Đổi trạng thái firmware",
    FIRMWARE_TARGET: "Gán firmware",
    OPERATION_CREATED: "Gửi yêu cầu thao tác",
    BOOT_REPORT: "Thiết bị khởi động",
    DEVICE_STATUS: "Nhận trạng thái thiết bị",
    COMMAND_ACK: "Thiết bị nhận lệnh",
    COMMAND_PROGRESS: "Nhận tiến độ thao tác",
    COMMAND_RESULT: "Nhận kết quả thao tác",
    KEY_PROPOSAL: "Thiết bị đề xuất khóa mới",
    KEY_ACTIVATED: "Thiết bị kích hoạt khóa mới",
    LOCAL_REQUEST: "Thiết bị yêu cầu bảo trì",
    RESULT_CONFLICT: "Kết quả thao tác không khớp",
};
function AuditDetail({ row: r }: { row: import("zod").infer<typeof C.AuditSummary> }) {
    let detail: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(r.detail);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed;
    } catch {}
    const description = r.operationAction
        ? (actionLabels[r.operationAction] ?? "Thao tác thiết bị") +
          (r.operationState ? " · " + operationLabel(r.operationState) : "")
        : r.firmwareVersion
          ? "Firmware " + r.firmwareVersion
          : r.action === "CHECK_IN_ACCEPTED"
            ? (r.subjectName ?? "Chưa có tên")
            : r.action === "TIME_SETTINGS_UPDATED" && typeof detail.server === "string"
              ? "Máy chủ: " + detail.server
              : r.action === "RELEASE_STATE_CHANGED"
                ? detail.state === "REVOKED"
                    ? "Đã thu hồi"
                    : detail.state === "APPROVED"
                      ? "Đã duyệt"
                      : "Đã thay đổi"
                : "—";
    return (
        <>
            {description}
            <details>
                <summary>Mã tra cứu</summary>
                <dl>
                    <dt>Mã sự kiện</dt>
                    <dd>
                        <code>{r.eventId}</code>
                    </dd>
                    <dt>Mã người thao tác</dt>
                    <dd>
                        <code>{r.actorId}</code>
                    </dd>
                    {typeof detail.operationId === "string" && (
                        <>
                            <dt>Mã yêu cầu thao tác</dt>
                            <dd>
                                <code>{detail.operationId}</code>
                            </dd>
                        </>
                    )}
                    <dt>Loại sự kiện</dt>
                    <dd>
                        <code>{r.action}</code>
                    </dd>
                </dl>
            </details>
        </>
    );
}
export function Policy() {
    const query = useRead("/check-in-policy", S.Policy),
        context = useRead("/context", BridgeContext);
    return (
        <>
            <h1>Chính sách QR</h1>
            <ReadState query={query}>
                {query.data && (
                    <PolicyForm
                        key={JSON.stringify(query.data)}
                        value={query.data}
                        editable={context.data?.policyEditable ?? false}
                    />
                )}
            </ReadState>
        </>
    );
}
function PolicyForm({
    value,
    editable,
}: {
    value: import("zod").infer<typeof S.Policy>;
    editable: boolean;
}) {
    const { api } = useModule(),
        refresh = useRefresh(),
        [confirm, setConfirm] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState<unknown>(),
        intent = useIntent(),
        form = useForm({ resolver: zodResolver(S.Policy), defaultValues: value });
    return (
        <form onSubmit={form.handleSubmit(() => setConfirm(true))}>
            {!editable && <p>Chỉ đọc: chưa cấu hình credential vận hành có quyền policy:write.</p>}
            {(["maxAgeMs", "futureSkewMs"] as const).map((k) => (
                <Field
                    key={k}
                    label={
                        k === "maxAgeMs"
                            ? "Tuổi QR tối đa (ms, 30000–60000)"
                            : "Độ lệch tương lai (ms, 0–5000)"
                    }
                    error={form.formState.errors[k]?.message}
                >
                    <input
                        type="number"
                        disabled={!editable}
                        {...form.register(k, { valueAsNumber: true })}
                    />
                </Field>
            ))}
            <Button disabled={!editable || busy}>Lưu chính sách</Button>
            {!!error && <Problem error={error} />}
            <Confirm
                open={confirm}
                title="Đổi chính sách xác minh QR"
                description="Thay đổi được audit và áp dụng tại backend. Đây không phải lệnh flash hoặc cập nhật thiết bị."
                busy={busy}
                onClose={() => setConfirm(false)}
                onConfirm={async () => {
                    setBusy(true);
                    try {
                        await intent.run(form.getValues(), (key) =>
                            api.call("/check-in-policy", "PATCH", form.getValues(), S.Policy, key)
                        );
                        setConfirm(false);
                        await refresh();
                    } catch (e) {
                        setError(e);
                    } finally {
                        setBusy(false);
                    }
                }}
            />
        </form>
    );
}
