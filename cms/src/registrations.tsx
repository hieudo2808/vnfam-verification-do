import { useState } from "react";
import { Link } from "react-router";
import { z } from "zod";
import * as R from "../../src/registration-contracts";
import { pageOf } from "../../src/contracts";
import { Field, PageButtons, ReadState, Stamp, useRead } from "./shared";

const labels: Record<z.infer<typeof R.RegistrationState>, string> = {
    CHALLENGE: "Chờ chứng minh sở hữu khóa",
    COMPLETED: "Đã đăng ký và cấp quyền kết nối",
    LOCKED: "Đã khóa",
    EXPIRED: "Đã hết hạn",
};

export function DeviceRegistrations() {
    const [state, setState] = useState("ALL"),
        [pages, setPages] = useState<string[]>([]),
        query = useRead(
            "/device-registrations?state=" +
                state +
                (pages.at(-1) ? "&cursor=" + pages.at(-1) : ""),
            pageOf(R.RegistrationMeta),
            2000
        );
    return (
        <>
            <Link to=".." relative="path">
                ← Thiết bị
            </Link>
            <h1>Đăng ký thiết bị</h1>
            <p>Thiết bị được tự xác nhận sau khi chứng minh sở hữu khóa. Theo dõi tiến trình đăng ký tại đây.</p>
            <Field label="Trạng thái đăng ký">
                <select
                    value={state}
                    onChange={(e) => {
                        setState(e.target.value);
                        setPages([]);
                    }}
                >
                    <option value="ALL">Tất cả</option>
                    {R.RegistrationState.options.map((s) => (
                        <option key={s} value={s}>
                            {labels[s]}
                        </option>
                    ))}
                </select>
            </Field>
            <ReadState query={query}>
                {query.data && !query.data.items.length && <p>Chưa có đăng ký phù hợp.</p>}
                <div className="table-wrap">
                    <table>
                        <caption className="sr-only">Tiến trình đăng ký thiết bị</caption>
                        <thead>
                            <tr>
                                <th>Thiết bị</th>
                                <th>Mã yêu cầu / khóa</th>
                                <th>Nhận lúc</th>
                                <th>Trạng thái</th>
                            </tr>
                        </thead>
                        <tbody>
                            {query.data?.items.map((r) => (
                                <tr key={r.registrationId}>
                                    <td>
                                        {r.deviceId ? (
                                            <Link to={"../" + r.deviceId} relative="path">
                                                {r.serial?.trim() || r.hardwareTarget}
                                            </Link>
                                        ) : (
                                            r.serial?.trim() || r.hardwareTarget
                                        )}
                                        <small>{r.hardwareTarget}</small>
                                    </td>
                                    <td>
                                        <code>{r.registrationId}</code>
                                        <small>
                                            <code>{r.keyId}</code>
                                        </small>
                                    </td>
                                    <td>
                                        <Stamp value={r.createdAt} />
                                    </td>
                                    <td>{labels[r.state]}</td>
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
        </>
    );
}
