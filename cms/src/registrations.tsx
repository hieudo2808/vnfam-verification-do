import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import * as R from "../../src/registration-contracts";
import { pageOf, Ok } from "../../src/contracts";
import { Button } from "./components/ui/button";
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
import { useIntent } from "./intent";

export function DeviceRegistrations() {
    const [pages, setPages] = useState<string[]>([]),
        query = useRead(
            "/device-registrations?state=PENDING" + (pages.at(-1) ? "&cursor=" + pages.at(-1) : ""),
            pageOf(R.RegistrationMeta),
            2000
        );
    const [selected, setSelected] = useState<z.infer<typeof R.RegistrationMeta> | null>(null),
        [reject, setReject] = useState(false),
        [name, setName] = useState(""),
        [busy, setBusy] = useState(false),
        [error, setError] = useState<unknown>();
    const { api } = useModule(),
        refresh = useRefresh(),
        intent = useIntent(),
        navigate = useNavigate(),
        lock = useRef(false);
    async function submit() {
        if (!selected || lock.current) return;
        lock.current = true;
        setBusy(true);
        setError(undefined);
        try {
            const input = reject ? undefined : R.RegistrationApproval.parse({ name });
            const result = await intent.run(
                { id: selected.registrationId, reject, ...input },
                (key) =>
                    api.call(
                        "/device-registrations/" +
                            selected.registrationId +
                            (reject ? "" : "/approve"),
                        reject ? "DELETE" : "POST",
                        input,
                        z.union([Ok, R.RegistrationMeta]),
                        key
                    )
            );
            setSelected(null);
            await refresh();
            if ("deviceId" in result && typeof result.deviceId === "string")
                navigate("../" + result.deviceId, { relative: "path" });
        } catch (e) {
            setError(e);
        } finally {
            setBusy(false);
            lock.current = false;
        }
    }
    return (
        <>
            <Link to=".." relative="path">
                ← Thiết bị
            </Link>
            <h1>Thiết bị chờ duyệt</h1>
            <ReadState query={query}>
                {query.data && !query.data.items.length && (
                    <p>Chưa có yêu cầu. Kết nối Wi-Fi cho ESP32 và bật máy để gửi đăng ký.</p>
                )}
                <div className="table-wrap">
                    <table>
                        <caption className="sr-only">Yêu cầu đăng ký thiết bị</caption>
                        <thead>
                            <tr>
                                <th>Thiết bị</th>
                                <th>Mã yêu cầu</th>
                                <th>Nhận lúc</th>
                                <th>Duyệt</th>
                            </tr>
                        </thead>
                        <tbody>
                            {query.data?.items.map((r) => (
                                <tr key={r.registrationId}>
                                    <td>
                                        {r.hardwareTarget}
                                        <small>{r.serial ?? "Không có số serial"}</small>
                                    </td>
                                    <td>
                                        <code>{r.registrationId}</code>
                                    </td>
                                    <td>
                                        <Stamp value={r.createdAt} />
                                    </td>
                                    <td>
                                        <div className="actions">
                                            <Button
                                                onClick={() => {
                                                    setSelected(r);
                                                    setReject(false);
                                                    setName("");
                                                    setError(undefined);
                                                }}
                                            >
                                                Duyệt
                                            </Button>
                                            <Button
                                                variant="outline"
                                                onClick={() => {
                                                    setSelected(r);
                                                    setReject(true);
                                                    setError(undefined);
                                                }}
                                            >
                                                Từ chối
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
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
            <Confirm
                open={!!selected}
                title={reject ? "Từ chối thiết bị" : "Duyệt thiết bị"}
                description={
                    (selected?.serial ?? selected?.hardwareTarget ?? "") +
                    " · " +
                    (selected?.registrationId ?? "")
                }
                busy={busy}
                confirmDisabled={!reject && !name.trim()}
                onClose={() => setSelected(null)}
                onConfirm={() => void submit()}
            >
                {!reject && (
                    <Field label="Tên / vị trí máy">
                        <input
                            value={name}
                            maxLength={200}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Sảnh A, tòa A1"
                        />
                    </Field>
                )}
                {!!error && <Problem error={error} />}
            </Confirm>
        </>
    );
}
