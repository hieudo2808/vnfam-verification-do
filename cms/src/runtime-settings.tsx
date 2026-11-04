import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as R from "../../src/runtime-contracts";
import * as S from "../../src/contracts";
import { pollInterval, operationLabel, saveIntent, ApiFailure } from "./client";
import {
    BridgeContext,
    Field,
    Problem,
    ReadState,
    Stamp,
    useModule,
    useRead,
    useRefresh,
} from "./shared";
import { Button } from "./components/ui/button";
import { useIntent } from "./intent";

export function TimeSettingsPage() {
    const query = useRead("/time-settings", R.TimeSettings),
        context = useRead("/context", BridgeContext);
    return (
        <>
            <h1>Thời gian</h1>
            <ReadState query={query}>
                {query.data && (
                    <>
                        {context.data && (
                            <p>
                                <strong>Giờ máy chủ</strong>{" "}
                                <time dateTime={new Date(context.data.serverTimeMs).toISOString()}>
                                    {new Intl.DateTimeFormat("vi-VN", {
                                        dateStyle: "short",
                                        timeStyle: "medium",
                                        timeZone: query.data.timezone,
                                    }).format(context.data.serverTimeMs)}
                                </time>{" "}
                                · {utcOffset(query.data.timezone)}
                            </p>
                        )}
                        <TimeForm value={query.data} editable={!!context.data?.policyEditable} />
                    </>
                )}
            </ReadState>
        </>
    );
}
function TimeForm({
    value,
    editable,
}: {
    value: import("zod").infer<typeof R.TimeSettings>;
    editable: boolean;
}) {
    const { api } = useModule(),
        refresh = useRefresh(),
        intent = useIntent(),
        [error, setError] = useState<unknown>(),
        [saved, setSaved] = useState(false);
    const form = useForm({
        resolver: zodResolver(R.TimeSettingsInput),
        defaultValues: { server: value.server, revision: value.revision, timezone: value.timezone },
    });
    const dirty = form.formState.isDirty;
    useEffect(() => {
        if (!dirty)
            form.reset({
                server: value.server,
                revision: value.revision,
                timezone: value.timezone,
            });
    }, [value.server, value.revision, value.timezone, dirty]);
    return (
        <section>
            <h2>Đồng bộ thời gian</h2>
            <form
                onSubmit={form.handleSubmit(async (input) => {
                    setError(undefined);
                    setSaved(false);
                    try {
                        const result = await intent.run(input, (key) =>
                            api.call("/time-settings", "PATCH", input, R.TimeSettings, key)
                        );
                        form.reset({
                            server: result.server,
                            revision: result.revision,
                            timezone: result.timezone,
                        });
                        setSaved(true);
                        await refresh();
                    } catch (e) {
                        setError(e);
                        await refresh();
                    }
                })}
            >
                <Field label="Địa chỉ máy chủ SNTP" error={form.formState.errors.server?.message}>
                    <input disabled={!editable} {...form.register("server")} />
                </Field>
                <Field label="Múi giờ" error={form.formState.errors.timezone?.message}>
                    <select disabled={!editable} {...form.register("timezone")}>
                        {Array.from(
                            new Set([value.timezone, ...Intl.supportedValuesOf("timeZone"), "UTC"])
                        ).map((zone) => (
                            <option key={zone} value={zone}>
                                {zone === "Asia/Ho_Chi_Minh" ? "Việt Nam" : zone} ({utcOffset(zone)}
                                )
                            </option>
                        ))}
                    </select>
                </Field>
                {!editable && <p>Chỉ đọc: chưa cấu hình quyền vận hành toàn hệ thống.</p>}
                {dirty && value.revision !== form.getValues("revision") && (
                    <p role="alert">
                        Cấu hình chung đã thay đổi. Bản nháp của bạn vẫn được giữ.{" "}
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => form.setValue("revision", value.revision)}
                        >
                            Dùng phiên bản mới để lưu bản nháp
                        </Button>
                    </p>
                )}
                <Button disabled={!editable || form.formState.isSubmitting}>
                    Lưu cho toàn hệ thống
                </Button>
                {!!error && <Problem error={error} />}{" "}
                {saved && <p role="status">Đã lưu máy chủ SNTP cho toàn hệ thống.</p>}
            </form>
        </section>
    );
}
export function NetworkConfigPanel({
    deviceId,
    onApply,
    scanSupported = false,
    scanDisabledReason,
    disabledReason = "Chưa có thao tác áp dụng.",
}: {
    deviceId: string;
    config?: unknown;
    onApply?: () => void;
    scanSupported?: boolean;
    scanDisabledReason?: string;
    disabledReason?: string;
}) {
    const path = "/devices/" + deviceId,
        query = useRead(path + "/runtime-settings", R.RuntimeSettings),
        { api } = useModule(),
        refresh = useRefresh(),
        intent = useIntent();
    const [error, setError] = useState<unknown>(),
        [saved, setSaved] = useState(false),
        [openNetworkSsid, setOpenNetworkSsid] = useState<string | null>(null);
    const form = useForm({
        resolver: zodResolver(R.NetworkInput),
        defaultValues: { revision: 1, ssid: "", password: undefined as string | undefined },
    });
    const dirty = form.formState.isDirty;
    useEffect(() => {
        if (query.data && !dirty)
            form.reset({
                revision: query.data.network.revision,
                ssid: query.data.network.ssid ?? "",
                password: undefined,
            });
    }, [query.data, dirty]);
    const network = query.data?.network;
    return (
        <section>
            <h2>Cấu hình</h2>
            <ReadState query={query}>
                {query.data && (
                    <>
                        <p>
                            Đã lưu: phiên bản {network!.revision} · Máy đã áp dụng:{" "}
                            {network!.appliedRevision}.
                        </p>
                        <form
                            onSubmit={form.handleSubmit(async (input) => {
                                setError(undefined);
                                setSaved(false);
                                const value =
                                    openNetworkSsid === input.ssid
                                        ? { ...input, password: "" }
                                        : input;
                                try {
                                    const result = await intent.run(value, (key) =>
                                        api.call(
                                            path + "/network-config",
                                            "PATCH",
                                            value,
                                            R.NetworkConfig,
                                            key
                                        )
                                    );
                                    form.reset({
                                        revision: result.revision,
                                        ssid: result.ssid ?? "",
                                        password: undefined,
                                    });
                                    setSaved(true);
                                    await refresh();
                                } catch (e) {
                                    setError(e);
                                    await refresh();
                                }
                            })}
                        >
                            <h3>Wi-Fi</h3>
                            <WifiScanner
                                deviceId={deviceId}
                                supported={scanSupported}
                                disabledReason={scanDisabledReason}
                                onChoose={(ssid, open) => {
                                    setOpenNetworkSsid(open ? ssid : null);
                                    form.setValue("password", undefined, { shouldDirty: true });
                                    form.setValue("ssid", ssid, {
                                        shouldDirty: true,
                                        shouldValidate: true,
                                    });
                                }}
                            />
                            <Field
                                label="Tên mạng Wi-Fi (SSID)"
                                error={form.formState.errors.ssid?.message}
                            >
                                <input autoComplete="off" {...form.register("ssid")} />
                            </Field>
                            <Field
                                label="Mật khẩu Wi-Fi mới"
                                error={form.formState.errors.password?.message}
                            >
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    disabled={openNetworkSsid === form.watch("ssid")}
                                    {...form.register("password", {
                                        setValueAs: (v) => (v === "" ? undefined : v),
                                    })}
                                />
                            </Field>
                            <p>
                                Để trống để giữ mật khẩu đã lưu khi tên mạng không đổi. Mật khẩu
                                không được đọc lại.
                            </p>
                            {dirty && network!.revision !== form.getValues("revision") && (
                                <p role="alert">
                                    Có cấu hình mới từ người khác. Bản nháp vẫn được giữ.{" "}
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => form.setValue("revision", network!.revision)}
                                    >
                                        Dùng phiên bản mới để lưu bản nháp
                                    </Button>
                                </p>
                            )}
                            <div className="actions">
                                <Button disabled={form.formState.isSubmitting}>Lưu cấu hình</Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={dirty || !!disabledReason || !onApply}
                                    onClick={onApply}
                                >
                                    Áp dụng lên máy
                                </Button>
                            </div>
                            <p>
                                {dirty
                                    ? "Lưu bản nháp trước khi áp dụng."
                                    : disabledReason ||
                                      "Áp dụng cấu hình đã lưu. Nếu không kết nối được mạng mới, firmware phải khôi phục mạng cũ."}
                            </p>
                            {!!error && <Problem error={error} />}{" "}
                            {saved && (
                                <p role="status">
                                    Đã lưu cấu hình. Chọn Áp dụng lên máy khi sẵn sàng.
                                </p>
                            )}
                        </form>
                    </>
                )}
            </ReadState>
        </section>
    );
}

export function utcOffset(zone: string) {
    const label =
        new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })
            .formatToParts(new Date())
            .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    return label.replace("GMT", "UTC");
}
function WifiScanner({
    deviceId,
    supported,
    disabledReason,
    onChoose,
}: {
    deviceId: string;
    supported: boolean;
    disabledReason?: string;
    onChoose: (ssid: string, open: boolean) => void;
}) {
    const { api } = useModule(),
        intent = useIntent(),
        lock = useRef(false),
        [busy, setBusy] = useState(false),
        [operation, setOperation] = useState<import("zod").infer<typeof S.Operation> | null>(null),
        [error, setError] = useState<unknown>(),
        [uncertain, setUncertain] = useState(false);
    const query = useRead(
        "/devices/" + deviceId + "/operations/" + (operation?.operationId ?? ""),
        S.Operation,
        pollInterval(operation?.state ?? "CREATED"),
        !!operation
    );
    useEffect(() => {
        if (query.data) setOperation(query.data);
    }, [query.data]);
    const result =
        operation?.state === "SUCCEEDED"
            ? S.WifiScan.safeParse({
                  scannedAtMs: operation.result?.scannedAtMs,
                  wifiNetworks: operation.result?.wifiNetworks,
              })
            : null;
    const scan = result?.success ? result.data : null;
    async function scanNetworks() {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError(undefined);
        setUncertain(false);
        try {
            const op = await intent.run({ action: "SCAN_WIFI" }, async (key) => {
                saveIntent(deviceId, key);
                const found = await api.call(
                    "/devices/" + deviceId + "/operations?intentKey=" + key,
                    "GET",
                    undefined,
                    S.pageOf(S.Operation)
                );
                return (
                    found.items[0] ??
                    api.call(
                        "/devices/" + deviceId + "/commands",
                        "POST",
                        { action: "SCAN_WIFI" },
                        S.Operation,
                        key
                    )
                );
            });
            setOperation(op);
        } catch (e) {
            setError(e);
            setUncertain(!(e instanceof ApiFailure) || e.status === 0 || e.status >= 500);
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }
    const running = !!operation && !S.finalStates.some((s) => s === operation.state);
    return (
        <div>
            <Button
                type="button"
                variant="outline"
                disabled={!supported || !!disabledReason || busy || running}
                onClick={() => void scanNetworks()}
            >
                {busy || running ? "Đang quét…" : uncertain ? "Đối chiếu lần quét" : "Quét Wi-Fi"}
            </Button>
            {!supported && <p>Firmware chưa hỗ trợ quét Wi-Fi. Nhập tên mạng bên dưới.</p>}
            {supported && disabledReason && <p>{disabledReason}</p>}
            {!!error && <Problem error={error} />}{" "}
            {query.error && <Problem error={query.error} retry={query.refetch} />}
            {operation && !scan && <p role="status">{operationLabel(operation.state)}</p>}
            {scan && (
                <>
                    <small>
                        Quét lúc <Stamp value={scan.scannedAtMs} />
                    </small>
                    {scan.wifiNetworks.length ? (
                        <div className="wifi-networks">
                            {[...scan.wifiNetworks]
                                .sort((a, b) => b.rssiDbm - a.rssiDbm)
                                .map((n, index) => (
                                    <Button
                                        type="button"
                                        key={index}
                                        variant="outline"
                                        disabled={
                                            !n.ssid ||
                                            ["WPA2_ENTERPRISE", "WEP", "UNKNOWN"].includes(
                                                n.authMode
                                            )
                                        }
                                        aria-label={"Chọn mạng " + n.ssid}
                                        onClick={() =>
                                            onChoose(n.ssid, ["OPEN", "OWE"].includes(n.authMode))
                                        }
                                    >
                                        <span>{n.ssid || "Mạng ẩn"}</span>
                                        <span>
                                            {n.rssiDbm} dBm ·{" "}
                                            {n.authMode === "OPEN"
                                                ? "Mở"
                                                : n.authMode.replaceAll("_", " ")}
                                        </span>
                                    </Button>
                                ))}
                        </div>
                    ) : (
                        <p>Không tìm thấy mạng.</p>
                    )}
                </>
            )}
        </div>
    );
}
