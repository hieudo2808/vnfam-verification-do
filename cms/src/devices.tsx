import { useState, useEffect } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import * as S from "../../src/contracts";
import * as C from "../../src/cms-contracts";
import { Button } from "./components/ui/button";
import {
    BridgeContext,
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
import { connectionLabel, operationLabel } from "./client";
import { Maintenance, OperationTable } from "./maintenance";
import { HistoryTable } from "./history";
import { useIntent } from "./intent";
import { useQueryClient } from "@tanstack/react-query";
export function Devices() {
    const [params, setParams] = useSearchParams(),
        [pages, setPages] = useState<string[]>([]),
        cursor = pages.at(-1);
    const q = new URLSearchParams(params);
    if (cursor) q.set("cursor", cursor);
    const list = useRead("/device-summaries?" + q, S.pageOf(C.Summary));
    const filter = (key: string, value: string) => {
        setPages([]);
        setParams((p) => {
            value ? p.set(key, value) : p.delete(key);
            return p;
        });
    };
    return (
        <>
            <div className="heading">
                <div>
                    <h1>Thiết bị</h1>
                </div>
            </div>
            <div className="filters">
                <Field label="Tìm theo tên hoặc mã">
                    <input
                        value={params.get("q") ?? ""}
                        onChange={(e) => filter("q", e.target.value)}
                    />
                </Field>
                <Field label="Danh tính">
                    <select
                        value={params.get("identity") ?? ""}
                        onChange={(e) => filter("identity", e.target.value)}
                    >
                        <option value="">Tất cả</option>
                        {C.Identity.options.map((s) => (
                            <option key={s} value={s}>
                                {operationLabel(s)}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Kết nối">
                    <select
                        value={params.get("connection") ?? ""}
                        onChange={(e) => filter("connection", e.target.value)}
                    >
                        <option value="">Tất cả</option>
                        {C.Connection.shape.state.options.map((s) => (
                            <option key={s} value={s}>
                                {connectionLabel(s)}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Tiếp nhận">
                    <select
                        value={params.get("accepting") ?? ""}
                        onChange={(e) => filter("accepting", e.target.value)}
                    >
                        <option value="">Tất cả</option>
                        <option value="true">Bật</option>
                        <option value="false">Tắt</option>
                    </select>
                </Field>
            </div>
            <ReadState query={list}>
                {list.data && (
                    <>
                        <div className="table-wrap">
                            <table>
                                <caption className="sr-only">Danh sách thiết bị</caption>
                                <thead>
                                    <tr>
                                        <th>Thiết bị / Vị trí</th>
                                        <th>Danh tính</th>
                                        <th>Kết nối</th>
                                        <th>Tiếp nhận</th>
                                        <th>Firmware / Thao tác</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {list.data.items.map((s) => (
                                        <tr key={s.device.deviceId}>
                                            <td>
                                                <Link to={s.device.deviceId}>{s.device.name}</Link>
                                                <code>{s.device.deviceId}</code>
                                            </td>
                                            <td>{operationLabel(s.identity)}</td>
                                            <td>
                                                {connectionLabel(s.connection.state)}
                                                <small>
                                                    Cập nhật:{" "}
                                                    <Stamp value={s.connection.observedAt} />
                                                </small>
                                            </td>
                                            <td>{s.device.checkInEnabled ? "Bật" : "Tắt"}</td>
                                            <td>
                                                {s.device.firmwareVersion ?? "Chưa có BOOT"}
                                                <small>
                                                    {s.activeOperation
                                                        ? operationLabel(s.activeOperation.state)
                                                        : "Không có thao tác đang chạy"}
                                                </small>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {!list.data.items.length && <p>Không có thiết bị phù hợp.</p>}
                        <PageButtons
                            next={list.data.nextCursor}
                            previous={pages.length > 0}
                            onNext={() => setPages([...pages, list.data!.nextCursor!])}
                            onPrevious={() => setPages((p) => p.slice(0, -1))}
                        />
                    </>
                )}
            </ReadState>
        </>
    );
}
export function NewDevice() {
    const context = useRead("/context", BridgeContext),
        { api } = useModule(),
        navigate = useNavigate(),
        [error, setError] = useState<unknown>(),
        [deviceId] = useState(() => crypto.randomUUID()),
        intent = useIntent(),
        defaults = context.data?.deviceDefaults;
    const schema = S.DeviceInput.pick({ name: true });
    const form = useForm<z.infer<typeof schema>>({
        resolver: zodResolver(schema),
        defaultValues: { name: "" },
    });
    return (
        <>
            <h1>Thêm thiết bị</h1>
            <form
                onSubmit={form.handleSubmit(async ({ name }) => {
                    if (!defaults) return;
                    try {
                        const value = { ...defaults, deviceId, doorId: deviceId, name };
                        const d = await intent.run(value, (key) =>
                            api.call("/devices", "POST", value, S.Device, key)
                        );
                        navigate("../" + d.deviceId, { relative: "path" });
                    } catch (e) {
                        setError(e);
                    }
                })}
            >
                <Field label="Tên / vị trí máy" error={form.formState.errors.name?.message}>
                    <input
                        placeholder="Ví dụ: Sảnh A, tòa A1"
                        {...form.register("name")}
                        aria-invalid={!!form.formState.errors.name}
                    />
                </Field>
                {!!error && <Problem error={error} />}
                {context.error && <Problem error={context.error} retry={context.refetch} />}
                {context.data && !defaults && (
                    <p role="alert">Chưa cấu hình hệ thống cho việc thêm máy.</p>
                )}
                <Button disabled={form.formState.isSubmitting || !defaults}>Tạo hồ sơ</Button>
            </form>
            <p>Sau khi tạo hồ sơ, mở ghép nối để kết nối thiết bị.</p>
        </>
    );
}
export function DeviceDetail() {
    const { deviceId } = useParams();
    return <Detail key={deviceId} deviceId={deviceId!} />;
}
function Detail({ deviceId }: { deviceId: string }) {
    const path = "/devices/" + deviceId,
        { api } = useModule(),
        refresh = useRefresh(),
        [tab, setTab] = useSearchParams(),
        [error, setError] = useState<unknown>();
    const [fast, setFast] = useState(false),
        query = useRead(path + "/overview", C.Overview, fast ? 2000 : 15000),
        d = query.data;
    useEffect(() => {
        setFast(
            !!d &&
                (d.pairing?.state === "PENDING" ||
                    d.recentOperations.some((x) =>
                        ["CREATED", "SENT", "ACKNOWLEDGED", "RUNNING"].includes(x.operation.state)
                    ))
        );
    }, [d]);
    return (
        <>
            <Link to=".." relative="path">
                ← Thiết bị
            </Link>
            <ReadState query={query}>
                {d && (
                    <>
                        <h1>{d.device.name}</h1>
                        <p>
                            <code>{deviceId}</code>
                        </p>
                        <div className="status-strip">
                            <span>{operationLabel(d.identity)}</span>
                            <span>
                                {connectionLabel(d.connection.state)} —{" "}
                                <Stamp value={d.connection.observedAt} />
                            </span>
                            <span>Tiếp nhận: {d.device.checkInEnabled ? "Bật" : "Tắt"}</span>
                        </div>
                        <nav aria-label="Chi tiết máy">
                            {[
                                ["overview", "Tổng quan"],
                                ["maintenance", "Bảo trì"],
                                ["history", "Lịch sử"],
                            ].map(([id, label]) => (
                                <Button
                                    variant={
                                        (tab.get("tab") ?? "overview") === id
                                            ? "default"
                                            : "outline"
                                    }
                                    key={id}
                                    onClick={() => setTab({ tab: id! })}
                                >
                                    {label}
                                </Button>
                            ))}
                        </nav>
                        {(tab.get("tab") ?? "overview") === "overview" && (
                            <>
                                <section>
                                    <h2>Hồ sơ</h2>
                                    <Profile device={d.device} />
                                    <Button
                                        variant="outline"
                                        onClick={async () => {
                                            try {
                                                await api.call(
                                                    path,
                                                    "PATCH",
                                                    { checkInEnabled: !d.device.checkInEnabled },
                                                    S.Device,
                                                    crypto.randomUUID()
                                                );
                                                await refresh();
                                            } catch (e) {
                                                setError(e);
                                            }
                                        }}
                                    >
                                        {d.device.checkInEnabled ? "Tắt" : "Bật"} tiếp nhận check-in
                                    </Button>
                                    {!!error && <Problem error={error} />}
                                    <dl>
                                        <dt>Firmware</dt>
                                        <dd>
                                            {d.device.firmwareVersion ?? "Chưa có"} /{" "}
                                            {d.device.buildId ?? "—"}
                                        </dd>
                                        <dt>Hardware / OTA slot</dt>
                                        <dd>
                                            {d.device.hardwareTarget ?? "—"} /{" "}
                                            {d.device.otaSlotBytes ?? "—"} byte
                                        </dd>
                                        <dt>Capabilities</dt>
                                        <dd>
                                            {d.device.capabilities.join(", ") || "Chưa có BOOT"}
                                        </dd>
                                    </dl>
                                </section>
                                <DeleteDevice device={d.device} />
                                <EnrollmentPanel data={d} observedAtMs={query.dataUpdatedAt} />
                            </>
                        )}
                        {tab.get("tab") === "maintenance" && <Maintenance data={d} />}{" "}
                        {tab.get("tab") === "history" && (
                            <>
                                <OperationTable deviceId={deviceId} />
                                <HistoryTable kind="audit-events" deviceId={deviceId} />
                            </>
                        )}
                    </>
                )}
            </ReadState>
        </>
    );
}
function DeleteDevice({ device }: { device: z.infer<typeof S.Device> }) {
    const context = useRead("/context", BridgeContext),
        { api, setPairingSecrets } = useModule(),
        client = useQueryClient(),
        navigate = useNavigate(),
        intent = useIntent();
    const [open, setOpen] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState<unknown>();
    if (
        !context.data?.permissions.includes("devices:write") ||
        !context.data.permissions.includes("credentials:revoke")
    )
        return null;
    return (
        <section>
            <Button variant="destructive" onClick={() => setOpen(true)}>
                Xóa thiết bị
            </Button>
            <Confirm
                open={open}
                title="Xóa thiết bị"
                description={`${device.name} · ${device.deviceId} · ${device.siteId} / ${device.doorId}. Máy sẽ bị xóa khỏi danh sách, ngắt kết nối và không thể check-in. Lịch sử được giữ lại.`}
                busy={busy}
                onClose={() => setOpen(false)}
                onConfirm={async () => {
                    if (busy) return;
                    setBusy(true);
                    setError(undefined);
                    try {
                        await intent.run({ deviceId: device.deviceId }, (key) =>
                            api.call("/devices/" + device.deviceId, "DELETE", undefined, S.Ok, key)
                        );
                        setPairingSecrets?.((current) => {
                            const next = { ...current };
                            delete next[device.deviceId];
                            return next;
                        });
                        await client.invalidateQueries({ refetchType: "none" });
                        navigate("..", { relative: "path" });
                    } catch (e) {
                        setError(e);
                        setBusy(false);
                    }
                }}
            >
                {!!error && <Problem error={error} />}
            </Confirm>
        </section>
    );
}
function EnrollmentPanel({
    data,
    observedAtMs,
}: {
    data: z.infer<typeof C.Overview>;
    observedAtMs: number;
}) {
    const { pairingSecrets } = useModule(),
        pendingRecovery =
            data.pairing?.state === "PENDING" || !!pairingSecrets?.[data.device.deviceId],
        recover = pendingRecovery || data.identity === "REPAIR_REQUIRED";
    if (!recover) return null;
    return (
        <details open={pendingRecovery}>
            <summary>Khôi phục ghép nối</summary>
            <PairingPanel data={data} observedAtMs={observedAtMs} />
        </details>
    );
}
function Profile({ device }: { device: z.infer<typeof S.Device> }) {
    const { api } = useModule(),
        refresh = useRefresh(),
        [error, setError] = useState<unknown>(),
        intent = useIntent();
    const form = useForm({
        resolver: zodResolver(S.DeviceInput.pick({ name: true })),
        defaultValues: { name: device.name },
    });
    return (
        <form
            onSubmit={form.handleSubmit(async (value) => {
                try {
                    await intent.run(value, (key) =>
                        api.call("/devices/" + device.deviceId, "PATCH", value, S.Device, key)
                    );
                    await refresh();
                } catch (e) {
                    setError(e);
                }
            })}
        >
            <Field label="Tên / vị trí máy" error={form.formState.errors.name?.message}>
                <input {...form.register("name")} />
            </Field>
            {!!error && <Problem error={error} />}
            <Button variant="outline" disabled={form.formState.isSubmitting}>
                Lưu hồ sơ
            </Button>
        </form>
    );
}
function PairingPanel({
    data,
    observedAtMs,
}: {
    data: z.infer<typeof C.Overview>;
    observedAtMs: number;
}) {
    const { api, pairingSecrets, setPairingSecrets } = useModule(),
        refresh = useRefresh(),
        stored = pairingSecrets?.[data.device.deviceId],
        secret = stored?.pairing,
        [confirm, setConfirm] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState<unknown>(),
        [remaining, setRemaining] = useState(0),
        pairingIntent = useIntent(),
        cancelIntent = useIntent();
    const setSecret = (pairing: z.infer<typeof S.Pairing> | null) =>
        setPairingSecrets?.((current) => {
            const next = { ...current };
            if (pairing?.code)
                next[data.device.deviceId] = {
                    pairing,
                    expiresAtClientMs: pairing.expiresAt - (data.serverTimeMs - observedAtMs),
                };
            else delete next[data.device.deviceId];
            return next;
        });
    useEffect(() => {
        if (!stored) return;
        const update = () =>
            setRemaining(Math.max(0, Math.ceil((stored.expiresAtClientMs - Date.now()) / 1000)));
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [stored]);
    useEffect(() => {
        const meta = data.pairing;
        // The overview from before creation must not erase the newly returned code.
        if (
            secret &&
            meta &&
            (meta.pairingId === secret.pairingId
                ? meta.state !== "PENDING"
                : meta.expiresAt >= secret.expiresAt)
        )
            setSecret(null);
    }, [data.pairing, secret]);
    return (
        <section>
            <h2>Ghép nối</h2>
            <p>
                {data.pairing?.state === "CONSUMED"
                    ? "Thông tin ghép nối đã được sử dụng"
                    : data.pairing
                      ? operationLabel(data.pairing.state)
                      : "Chưa có phiên"}{" "}
                · {operationLabel(data.identity)}
            </p>
            {secret?.code && (
                <div role="status">
                    <p>
                        Mã còn {remaining} giây. Đổi tab hoặc xem máy khác vẫn giữ mã; tải lại trang
                        sẽ mất mã.
                    </p>
                    <code className="pairing-secret">{secret.code}</code>
                    <p>ID: {secret.pairingId}</p>
                    <p>Nonce: {secret.nonce}</p>
                    <Button
                        variant="outline"
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(JSON.stringify(secret));
                            } catch (e) {
                                setError(e);
                            }
                        }}
                    >
                        Sao chép thông tin ghép nối
                    </Button>
                    <Button variant="outline" onClick={() => setSecret(null)}>
                        Ẩn mã
                    </Button>
                </div>
            )}
            {data.pairing?.state === "PENDING" && !secret?.code && (
                <p role="status">
                    Mã không còn trong lượt mở CMS này. Bấm “Hủy phiên”, rồi tạo phiên ghép nối mới
                    để nhận mã mới.
                </p>
            )}
            {data.identity === "CONFIRMED" && data.pairing?.state !== "PENDING" ? (
                <p>
                    Thiết bị đã được xác nhận sau ghép nối. Xem trạng thái kết nối ở đầu trang hoặc
                    sang tab Bảo trì.
                </p>
            ) : (
                <>
                    <h3>Làm gì tiếp?</h3>
                    <ol>
                        <li>
                            Sao chép thông tin ghép nối và chuyển vào ESP32 bằng cách firmware hỗ
                            trợ, ví dụ qua USB/serial khi nạp cấu hình.
                        </li>
                        <li>
                            Firmware tự sinh khóa, gọi API hoàn tất ghép nối, lưu token rồi mở kết
                            nối WebSocket và gửi báo cáo khởi động.
                        </li>
                        <li>
                            Đợi CMS hiện “Đã xác nhận”. Chỉ tạo phiên hoặc gửi thông tin ghép nối
                            chưa hoàn tất bước này.
                        </li>
                    </ol>
                    <p>
                        CMS chưa thể tự gửi mã vào máy chưa ghép nối. Nếu firmware hiện chỉ hiển thị
                        QR, đội firmware cần bổ sung chức năng ghép nối. Mã này không phải QR
                        check-in cho khách.
                    </p>
                </>
            )}
            <Button
                disabled={busy || !!secret || data.pairing?.state === "PENDING"}
                onClick={() => setConfirm(true)}
            >
                {data.device.generation ? "Ghép lại danh tính" : "Tạo phiên ghép nối"}
            </Button>
            {data.pairing?.state === "PENDING" && (
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await cancelIntent.run({ pairingId: data.pairing!.pairingId }, (key) =>
                                api.call(
                                    "/device-pairings/" + data.pairing!.pairingId,
                                    "DELETE",
                                    undefined,
                                    S.Ok,
                                    key
                                )
                            );
                            setSecret(null);
                            await refresh();
                        } catch (e) {
                            setError(e);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    Hủy phiên
                </Button>
            )}
            {!!error && <Problem error={error} />}
            <Confirm
                open={confirm}
                title="Xác nhận ghép nối"
                description={`${data.device.name} · ${data.device.deviceId}. ${data.device.generation ? "Hoàn tất ghép lại sẽ thu hồi danh tính, credential và khóa cũ." : "Tạo mã ghép nối có hạn 10 phút để chuyển vào thiết bị."}`}
                busy={busy}
                onClose={() => setConfirm(false)}
                onConfirm={async () => {
                    setBusy(true);
                    setError(undefined);
                    try {
                        setSecret(
                            await pairingIntent.run(
                                {
                                    deviceId: data.device.deviceId,
                                    replaceIdentity: data.device.generation > 0,
                                },
                                (key) =>
                                    api.call(
                                        "/device-pairings",
                                        "POST",
                                        {
                                            deviceId: data.device.deviceId,
                                            replaceIdentity: data.device.generation > 0,
                                        },
                                        S.Pairing,
                                        key
                                    )
                            )
                        );
                        setConfirm(false);
                    } catch (e) {
                        setError(e);
                        setConfirm(false);
                    } finally {
                        await refresh();
                        setBusy(false);
                    }
                }}
            />
        </section>
    );
}
