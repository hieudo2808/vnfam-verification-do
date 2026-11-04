import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { z } from "zod";
import * as S from "../../src/contracts";
import * as C from "../../src/cms-contracts";
import { ApiFailure } from "./client";
import { Button } from "./components/ui/button";
import { Confirm, Field, Problem, useModule, useRead, useRefresh } from "./shared";
import { FirmwareDeployment } from "./firmware-deployment";
import { readFirmwarePackage } from "./firmware-package";
import { prepareFirmware, type FirmwarePackage } from "./firmware-upload";
import { DeploymentItem, resumeDeployment } from "./deployment";
import { targetReason } from "./compatibility";
import { OperationDialog } from "./maintenance";
export { validateArtifact } from "./firmware-package";

const UploadIntent = z.strictObject({ releaseId: S.Id, createKey: S.Id, approveKey: S.Id });
function savedUpload(storage: string) {
    try {
        return UploadIntent.parse(JSON.parse(sessionStorage.getItem(storage) ?? "null"));
    } catch {
        return null;
    }
}
function uploadBinary(
    url: string,
    file: File,
    onProgress: (percent: number) => void,
    onVerifying: () => void,
    setRequest: (request: XMLHttpRequest) => void
) {
    return new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        setRequest(request);
        request.open("PUT", url);
        request.setRequestHeader("content-type", "application/octet-stream");
        request.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(Math.floor((e.loaded / e.total) * 100));
        };
        request.upload.onload = onVerifying;
        request.onload = () => {
            if (request.status >= 200 && request.status < 300) {
                try {
                    S.Ok.parse(JSON.parse(request.responseText));
                    resolve();
                } catch (error) {
                    reject(error);
                }
                return;
            }
            let code = "UPLOAD_FAILED",
                requestId = "";
            try {
                const body = JSON.parse(request.responseText);
                code = body.error.code;
                requestId = body.error.requestId;
            } catch {}
            reject(new ApiFailure(code, requestId, request.status));
        };
        request.onerror = () => reject(new ApiFailure("UPLOAD_RESPONSE_LOST"));
        request.onabort = () => reject(new ApiFailure("UPLOAD_CANCELLED"));
        request.send(file);
    });
}

export function Firmware() {
    return <FirmwarePage />;
}
export function FirmwareDetail() {
    const { releaseId } = useParams();
    return <FirmwarePage key={releaseId} releaseId={releaseId} />;
}
function FirmwarePage({ releaseId }: { releaseId?: string }) {
    const [ready, setReady] = useState<z.infer<typeof S.Release> | null>(null),
        [selecting, setSelecting] = useState(false),
        [storedId] = useState(
            () => releaseId ?? savedUpload("vnfam:firmware-upload:global")?.releaseId ?? ""
        );
    const query = useRead("/firmware-releases/" + storedId, S.Release, 15000, !!storedId),
        release = ready ?? (!selecting ? query.data : null);
    return (
        <>
            <h1>Firmware</h1>
            <FirmwareUpload
                onFileChange={() => {
                    setSelecting(true);
                    setReady(null);
                }}
                onReady={async (r) => {
                    setReady(r);
                }}
                expectedReleaseId={releaseId}
            />
            {storedId && query.error && (
                <Problem error={query.error} retry={() => query.refetch()} />
            )}
            {release?.state === "APPROVED" && release.verified && (
                <FirmwareDeployment key={release.releaseId} release={release} />
            )}
        </>
    );
}

const DeviceDeployment = z.strictObject({ releaseId: S.Id, item: DeploymentItem });
export function DeviceFirmwarePanel({ data }: { data: z.infer<typeof C.Overview> }) {
    const { api } = useModule(),
        refresh = useRefresh(),
        device = data.device,
        storage = "vnfam:device-firmware:" + device.deviceId;
    const [saved, setSaved] = useState<z.infer<typeof DeviceDeployment> | null>(() => {
            try {
                const value = DeviceDeployment.parse(
                    JSON.parse(sessionStorage.getItem(storage) ?? "null")
                );
                return value.item.deviceId === device.deviceId ? value : null;
            } catch {
                return null;
            }
        }),
        [error, setError] = useState<unknown>(),
        [open, setOpen] = useState(false),
        [reconciling, setReconciling] = useState(false);
    const active = useRef(true),
        latest = useRef(saved);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    const operation = useRead(
        "/devices/" + device.deviceId + "/operations/" + (saved?.item.operationId ?? ""),
        S.Operation,
        15000,
        !!saved?.item.operationId
    );
    function persist(value: z.infer<typeof DeviceDeployment>) {
        sessionStorage.setItem(storage, JSON.stringify(value));
        latest.current = value;
        setSaved(value);
    }
    async function dispatch(release: z.infer<typeof S.Release>) {
        let state = latest.current;
        if (!state || state.releaseId !== release.releaseId) {
            state = {
                releaseId: release.releaseId,
                item: {
                    deviceId: device.deviceId,
                    name: device.name,
                    targetKey: crypto.randomUUID(),
                    key: crypto.randomUUID(),
                    phase: "READY",
                    operationId: null,
                    error: "",
                },
            };
            persist(state);
        }
        const result = await resumeDeployment(
            release.releaseId,
            state.item,
            api.call.bind(api),
            (item) => persist({ releaseId: release.releaseId, item }),
            false,
            () => active.current
        );
        if (result.operationId) setOpen(true);
        await refresh();
        if (result.error) throw new ApiFailure("FIRMWARE_DISPATCH_UNCERTAIN");
    }
    async function reconcile() {
        if (!latest.current) return;
        setReconciling(true);
        setError(undefined);
        try {
            const value = latest.current;
            if (value.item.phase === "DISPATCHING")
                await resumeDeployment(
                    value.releaseId,
                    value.item,
                    api.call.bind(api),
                    (item) => persist({ releaseId: value.releaseId, item }),
                    true,
                    () => active.current
                );
            if (latest.current?.item.operationId) {
                await refresh();
                setOpen(true);
            }
        } catch (error) {
            setError(error);
        } finally {
            setReconciling(false);
        }
    }
    const reason =
        data.connection.state !== "ONLINE"
            ? "Máy chưa online."
            : !device.capabilities.includes("UPGRADE_FIRMWARE")
              ? "Firmware chưa hỗ trợ cập nhật từ xa."
              : data.activeOperation
                ? "Máy có thao tác chưa hoàn tất."
                : "";
    return (
        <section>
            <h2>Firmware</h2>
            <p>Đang chạy: {device.firmwareVersion ?? "Chưa có thông tin"}</p>
            <FirmwareUpload device={data} disabledReason={reason} onReady={dispatch} />
            {saved && (
                <Button variant="outline" disabled={reconciling} onClick={() => void reconcile()}>
                    Xem tiến trình cập nhật
                </Button>
            )}
            {saved?.item.error && <p role="alert">{saved.item.error}</p>}
            {!!error && <Problem error={error} />}
            <OperationDialog
                deviceId={device.deviceId}
                operation={operation.data ?? null}
                open={open}
                onClose={() => setOpen(false)}
            />
        </section>
    );
}

function FirmwareUpload({
    device,
    onReady,
    expectedReleaseId,
    disabledReason = "",
    onFileChange,
}: {
    device?: z.infer<typeof C.Overview>;
    onReady: (release: z.infer<typeof S.Release>) => Promise<void>;
    expectedReleaseId?: string;
    disabledReason?: string;
    onFileChange?: () => void;
}) {
    const { api } = useModule(),
        storage = "vnfam:firmware-upload:" + (device?.device.deviceId ?? "global");
    const [file, setFile] = useState<File | null>(null),
        [artifact, setArtifact] = useState<FirmwarePackage | null>(null),
        [error, setError] = useState<unknown>(),
        [busy, setBusy] = useState(false),
        [phase, setPhase] = useState(""),
        [percent, setPercent] = useState<number | null>(null),
        [confirm, setConfirm] = useState(false);
    const lock = useRef(false),
        xhr = useRef<XMLHttpRequest | null>(null),
        active = useRef(true),
        intent = useRef(savedUpload(storage));
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    async function execute(value: FirmwarePackage) {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError(undefined);
        setPercent(null);
        try {
            if (intent.current?.releaseId !== value.manifest.releaseId) {
                intent.current = {
                    releaseId: value.manifest.releaseId,
                    createKey: crypto.randomUUID(),
                    approveKey: crypto.randomUUID(),
                };
                sessionStorage.setItem(storage, JSON.stringify(intent.current));
            }
            const release = await prepareFirmware(
                api,
                value,
                intent.current,
                (url, binary) =>
                    uploadBinary(
                        url,
                        binary,
                        setPercent,
                        () => {
                            setPercent(null);
                            setPhase("Đang xác minh firmware…");
                        },
                        (request) => {
                            xhr.current = request;
                        }
                    ),
                setPhase
            );
            if (active.current) {
                await onReady(release);
                setPhase(device ? "Đã gửi yêu cầu cập nhật." : "Firmware sẵn sàng.");
                setConfirm(false);
            }
        } catch (error) {
            setError(error);
            setPhase("");
        } finally {
            lock.current = false;
            setBusy(false);
            xhr.current = null;
        }
    }
    async function submit() {
        if (!file || lock.current || busy) return;
        lock.current = true;
        setBusy(true);
        setError(undefined);
        let value: FirmwarePackage;
        try {
            value = await readFirmwarePackage(file);
            if (expectedReleaseId && value.manifest.releaseId !== expectedReleaseId)
                throw new ApiFailure("ARTIFACT_CONFLICT");
            if (device) {
                const reason = targetReason(device.device, {
                    ...value.manifest,
                    state: "APPROVED",
                    verified: true,
                    createdAt: 0,
                });
                if (reason) throw reason;
            }
            setArtifact(value);
        } catch (error) {
            setError(error);
            setBusy(false);
            lock.current = false;
            return;
        }
        setBusy(false);
        lock.current = false;
        if (device) setConfirm(true);
        else await execute(value);
    }
    const status = (
        <>
            <p role="status">
                {phase}
                {percent !== null ? " " + percent + "%" : ""}
            </p>
            {typeof error === "string" ? (
                <p role="alert">{error}</p>
            ) : (
                !!error && <Problem error={error} />
            )}
        </>
    );
    return (
        <div className="firmware-upload">
            <form
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Field label="File firmware">
                    <input
                        type="file"
                        accept=".zip,application/zip"
                        required
                        disabled={busy}
                        onChange={(e) => {
                            setFile(e.target.files?.[0] ?? null);
                            setArtifact(null);
                            setError(undefined);
                            setPhase("");
                            onFileChange?.();
                        }}
                    />
                </Field>
                <div className="actions">
                    <Button disabled={!file || busy || !!disabledReason}>
                        {busy ? "Đang xử lý…" : device ? "Tải lên và flash" : "Tải firmware"}
                    </Button>
                    {busy && xhr.current && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => xhr.current?.abort()}
                        >
                            Dừng tải
                        </Button>
                    )}
                </div>
                {disabledReason && <p>{disabledReason}</p>}
                {!confirm && status}
            </form>
            {device && (
                <Confirm
                    open={confirm}
                    title="Cập nhật firmware"
                    description={
                        device.device.name +
                        " · " +
                        device.device.deviceId +
                        ". Thiết bị sẽ khởi động lại để cập nhật."
                    }
                    busy={busy}
                    onClose={() => setConfirm(false)}
                    onConfirm={() => {
                        if (artifact) void execute(artifact);
                    }}
                >
                    {status}
                    {busy && xhr.current && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => xhr.current?.abort()}
                        >
                            Dừng tải
                        </Button>
                    )}
                </Confirm>
            )}
        </div>
    );
}
