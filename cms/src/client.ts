import { z } from "zod";
import { Id, finalStates } from "../../src/contracts";
export class ApiFailure extends Error {
    constructor(
        public code: string,
        public requestId = "",
        public status = 0
    ) {
        super(code);
    }
}
export class Api {
    constructor(
        public base = "/cms-api",
        private fetcher: typeof fetch = (input, init) => fetch(input, init)
    ) {
        if (!/^\/(?!\/)[^?#]*$/.test(base)) throw new Error("API must use a same-origin path");
    }
    async call<T = unknown>(
        path: string,
        method = "GET",
        body?: unknown,
        schema?: z.ZodType<T>,
        key?: string,
        signal?: AbortSignal
    ): Promise<T> {
        const response = await this.fetcher(this.base + path, {
            method,
            credentials: "same-origin",
            cache: "no-store",
            signal,
            headers: {
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...(key ? { "idempotency-key": key } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        if (!response.ok)
            throw new ApiFailure(
                data.error?.code ?? "REQUEST_FAILED",
                data.error?.requestId ?? "",
                response.status
            );
        return schema ? schema.parse(data) : data;
    }
}
const labels: Record<string, string> = {
    CREATED: "Đã tạo yêu cầu",
    SENT: "Đã bắt đầu gửi lệnh",
    ACKNOWLEDGED: "Máy đã xác nhận nhận lệnh",
    RUNNING: "Đang thực hiện",
    UNKNOWN: "Chưa xác định kết quả; cần đối chiếu",
    SUCCEEDED: "Hoàn tất",
    FAILED: "Thất bại",
    EXPIRED: "Hết hạn trước khi thực hiện",
    UNPAIRED: "Chưa đăng ký",
    AWAITING_BOOT: "Đang chờ thiết bị kết nối",
    CONFIRMED: "Đã xác nhận",
    REPAIR_REQUIRED: "Cần ghép lại",
    ONLINE: "Trực tuyến",
    OFFLINE: "Ngoại tuyến",
    PENDING: "Đang chờ",
    CONSUMED: "Đã ghép; chờ xác nhận kết nối",
    CANCELLED: "Đã hủy",
    LOCKED: "Đã khóa",
    ACTIVE: "Đang sử dụng",
    REVOKED: "Đã thu hồi",
    UPLOADING: "Đang tải / xác minh",
    DRAFT: "Đã xác minh, chờ duyệt",
    APPROVED: "Đã duyệt",
};
export const operationLabel = (s: string) => labels[s] ?? s;
export const connectionLabel = (s: string) =>
    s === "UNKNOWN" ? "Chưa cập nhật kết nối" : operationLabel(s);
export function pollInterval(
    state: string,
    visible = document.visibilityState !== "hidden",
    online = navigator.onLine
): number | false {
    return !visible || !online || finalStates.includes(state as (typeof finalStates)[number])
        ? false
        : state === "UNKNOWN"
          ? 15000
          : 2000;
}
const Intent = z.strictObject({ deviceId: Id, key: Id });
export function readIntent(deviceId: string) {
    try {
        const v = Intent.parse(
            JSON.parse(sessionStorage.getItem("vnfam:intent:" + deviceId) ?? "null")
        );
        return v.deviceId === deviceId ? v : null;
    } catch {
        return null;
    }
}
export function saveIntent(deviceId: string, key: string) {
    sessionStorage.setItem("vnfam:intent:" + deviceId, JSON.stringify({ deviceId, key }));
}
const messages: Record<string, string> = {
    FIRMWARE_PACKAGE_INVALID: "File firmware không đúng định dạng gói cập nhật.",
    ARTIFACT_SIZE_MISMATCH: "Dung lượng file firmware không khớp thông tin của gói.",
    ARTIFACT_HASH_MISMATCH: "File firmware bị lỗi hoặc đã bị thay đổi.",
    UPLOAD_CANCELLED: "Đã dừng tải firmware.",
    UPLOAD_RESPONSE_LOST: "Chưa xác nhận được kết quả tải. Chọn lại cùng file để đối chiếu.",
    PAYLOAD_TOO_LARGE: "File vượt dung lượng cho phép.",
    DEVICE_OFFLINE: "Máy đang offline. Hãy kết nối lại trước khi điều khiển.",
    REVISION_CONFLICT: "Cấu hình đã được thay đổi. Hãy đối chiếu phiên bản mới trước khi lưu lại.",
    IDEMPOTENCY_CONFLICT: "Ý định này đã được dùng với nội dung khác.",
    OPERATION_CONFLICT: "Máy có thao tác chưa hoàn tất hoặc chưa rõ kết quả.",
    POLICY_READ_ONLY: "Chưa cấu hình credential vận hành để sửa chính sách.",
    UNAUTHORIZED: "Credential không hợp lệ hoặc đã bị thu hồi.",
    FORBIDDEN: "Credential không có quyền hoặc ngoài phạm vi.",
    PAIRING_EXPIRED: "Phiên ghép nối đã hết hạn.",
    CAPABILITY_UNSUPPORTED: "Firmware chưa hỗ trợ thao tác này.",
    RUNTIME_CONFIG_UNSUPPORTED:
        "Firmware chưa hỗ trợ đổi Wi-Fi từ CMS. Cần cập nhật firmware trước.",
    WIFI_PASSWORD_REQUIRED:
        "Nhập mật khẩu cho mạng mới; mật khẩu cũ chỉ được giữ khi tên mạng không đổi.",
    CONFIG_ENCRYPTION_UNAVAILABLE: "Máy chủ chưa có khóa mã hóa cấu hình Wi-Fi.",
    CONFIG_DECRYPT_FAILED:
        "Không đọc được cấu hình Wi-Fi đã mã hóa. Cần kiểm tra khóa cấu hình trên máy chủ.",
    FIRMWARE_TARGET_CONFLICT:
        "Bản firmware được gán đã thay đổi. Hãy đối chiếu trước khi cập nhật.",
};
export function errorMessage(e: unknown) {
    return e instanceof ApiFailure
        ? (messages[e.code] ?? "Yêu cầu không thực hiện được (" + e.code + ").") +
              (e.requestId ? " Mã tra cứu: " + e.requestId : "")
        : "Không thể kết nối hoặc dữ liệu phản hồi không hợp lệ. Hãy thử lại.";
}
export const time = (v: number | null) =>
    v === null
        ? "Chưa có"
        : new Intl.DateTimeFormat("vi-VN", {
              dateStyle: "short",
              timeStyle: "medium",
              timeZone: "Asia/Ho_Chi_Minh",
          }).format(v);
