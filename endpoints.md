# Tài liệu Tham chiếu API & Danh mục Endpoint — VNFAM

Tài liệu này tổng hợp toàn bộ các endpoint HTTP/REST và WebSocket của backend **VNFAM Device API** (`vnfam-device-api`), quy chuẩn xác thực, định dạng dữ liệu đầu vào (Input), đầu ra (Output) và các mã lỗi tương ứng.

---

## 1. Quy ước chung

### 1.1. Host & Môi trường
- **Local (Wrangler API trực tiếp):** `http://127.0.0.1:8787`
- **Local CMS Bridge:** `http://127.0.0.1:8788/api`
- **Staging API:** `https://devices-staging.castorice.tech`
- **OpenAPI Schema:** `GET /openapi.json`

### 1.2. Cơ chế Xác thực (Authentication)
Backend sử dụng 3 mức xác thực độc lập:

1. **Công khai (No Auth):**
   - Không yêu cầu token. Dành cho probe hệ thống (`/health`, `/openapi.json`) và quét QR tại cửa (`/checkin`).
2. **Thiết bị ESP32 (`DeviceBearer`):**
   - Header: `Authorization: Bearer <device-token>`
   - Token nhận được sau khi thiết bị hoàn tất đăng ký hoặc khôi phục ghép nối (pairing).
3. **Dịch vụ nội bộ CMS / Minigame / Operator (`ServiceBearer`):**
   - Header: `Authorization: Bearer <service-token>`
   - Bắt buộc đi kèm:
     - `X-Actor-Id: <ascii-id>`: ID của người dùng hoặc subsystem thực hiện thao tác.
     - `X-Actor-Name: <url-encoded-name>` *(Tùy chọn)*: Tên hiển thị của actor để lưu nhật ký audit.
   - Thao tác thay đổi trạng thái (POST/PUT/PATCH/DELETE) bắt buộc gửi:
     - `Idempotency-Key: <uuid-hoac-id>`: Chống thực thi lặp (idempotent mutations).
   - Kiểm tra quyền (`permissions`) và phạm vi (`siteId`, `scopeId`) tương ứng của token.

### 1.3. Định dạng Lỗi Chuẩn (Error Body)
Mọi endpoint thuộc `/api/*` khi phát sinh lỗi đều trả về JSON có cấu trúc thống nhất:

```json
{
  "error": {
    "code": "DEVICE_NOT_FOUND",
    "message": "DEVICE_NOT_FOUND",
    "requestId": "9c123456-789a-bcde-f012-3456789abcde"
  }
}
```

*Ngoại lệ:* Endpoint xác minh QR `GET /checkin` dùng định dạng rút gọn: `{"error": "<code>"}`.

### 1.4. Bảng mã lỗi HTTP phổ biến
- `400 Bad Request`: Sai tham số query, định dạng QR hoặc thời gian `t` ở tương lai quá xa.
- `401 Unauthorized`: Thiếu hoặc sai Bearer token, hoặc chữ ký điện tử không hợp lệ.
- `403 Forbidden`: Token không đủ quyền hạn (permission) hoặc ngoài phạm vi (site/scope).
- `404 Not Found`: Không tìm thấy thiết bị, bản ghi, firmware hoặc thao tác tương ứng.
- `409 Conflict`: Xung đột phiên bản cấu hình (`REVISION_CONFLICT`), trùng khóa hoặc thao tác không hợp lệ với trạng thái hiện tại.
- `410 Gone`: Phiên đăng ký hoặc mã QR đã hết hạn hiệu lực.
- `413 Payload Too Large`: Payload vượt quá giới hạn (mặc định 64 KiB; nhị phân firmware tối đa 8 MiB).
- `422 Unprocessable Content`: Dữ liệu không thỏa mãn validation schema (Zod) hoặc chữ ký proof không hợp lệ.
- `429 Too Many Requests`: Vượt quá tần suất cho phép (Rate limited).
- `503 Service Unavailable`: Dịch vụ D1/R2 gián đoạn hoặc chưa cấu hình khóa mã hóa.

---

## 2. Bảng tổng hợp Endpoint

| Nhóm | Phương thức | Đường dẫn (Path) | Xác thực / Quyền | Mục đích |
|---|---|---|---|---|
| **Hệ thống** | `GET` | `/health` | Không | Kiểm tra liveness worker |
| | `GET` | `/openapi.json` | Không | Lấy schema OpenAPI 3.1 |
| **Check-in QR** | `GET` | `/checkin` | Không | Xác minh chữ ký QR tại cửa (chỉ xác thực) |
| | `POST` | `/api/check-ins` | `checkins:write` | Minigame ghi nhận biên lai check-in |
| | `GET` | `/api/check-ins/latest` | `checkins:read` | Lấy lượt check-in mới nhất của user |
| | `GET` | `/api/admin/check-in-policy` | `audit:read` | Xem chính sách hạn QR toàn cục |
| | `PATCH` | `/api/admin/check-in-policy` | `policy:write` (OPERATOR) | Cập nhật TTL / Skew của QR |
| | `GET` | `/api/admin/check-ins` | `audit:read` | Xem lịch sử check-in dạng biên lai |
| | `GET` | `/api/admin/check-in-summaries` | `audit:read` | Xem lịch sử check-in có kèm tên hiển thị |
| **Đăng ký ESP32** | `POST` | `/api/device-registrations` | Không | ESP32 xin challenge đăng ký |
| | `POST` | `/api/device-registrations/{id}/complete` | Không (Nonce + Proof) | ESP32 hoàn tất đăng ký; backend tự lưu máy, khóa và cấp credential |
| **Khôi phục Pairing** | `POST` | `/api/admin/device-pairings` | `pairings:write` | CMS tạo mã phiên ghép nối khôi phục |
| | `DELETE` | `/api/admin/device-pairings/{pairingId}` | `pairings:write` | CMS hủy phiên ghép nối |
| | `POST` | `/api/device-pairings/complete` | Không (Proof + Code) | ESP32 nộp proof để lấy token mới |
| **Quản lý Thiết bị** | `GET` | `/api/admin/devices` | `devices:read` | Danh sách thiết bị (phân trang) |
| | `POST` | `/api/admin/devices` | `devices:write` | Đăng ký thiết bị thủ công (REQ-TRUST) |
| | `GET` | `/api/admin/devices/{deviceId}` | `devices:read` | Chi tiết thiết bị + trạng thái online |
| | `PATCH` | `/api/admin/devices/{deviceId}` | `devices:write` | Sửa tên, vị trí, bật/tắt tiếp nhận |
| | `DELETE` | `/api/admin/devices/{deviceId}` | `devices:write` & `credentials:revoke` | Xóa máy khỏi danh sách, thu hồi truy cập |
| | `GET` | `/api/admin/devices/{deviceId}/config` | `devices:read` | Đọc cấu hình mong muốn và áp dụng |
| | `PATCH` | `/api/admin/devices/{deviceId}/config` | `devices:write` | Sửa cấu hình mong muốn (tăng revision) |
| | `DELETE` | `/api/admin/devices/{deviceId}/credential` | `credentials:revoke` | Thu hồi ngay token của thiết bị |
| | `POST` | `/api/admin/devices/{deviceId}/key-revocations` | `keys:revoke` | Thu hồi ngay khóa QR của thiết bị |
| **Lệnh & Tác vụ** | `POST` | `/api/admin/devices/{deviceId}/commands` | `commands:write` | Gửi lệnh vận hành tới ESP32 |
| | `POST` | `/api/admin/devices/{deviceId}/upgrades` | `commands:write` | Gửi lệnh nâng cấp firmware |
| | `GET` | `/api/admin/devices/{deviceId}/operations` | `devices:read` | Xem lịch sử thao tác của máy |
| | `GET` | `/api/admin/devices/{deviceId}/operations/{opId}` | `devices:read` | Xem chi tiết 1 thao tác |
| | `GET` | `/api/admin/devices/{deviceId}/events` | `audit:read` | Xem sự kiện kiểm toán của máy |
| **Tổng quan CMS** | `GET` | `/api/admin/context` | `devices:read` | Lấy danh sách quyền và phạm vi của token |
| | `GET` | `/api/admin/device-summaries` | `devices:read` | Danh sách snapshot tổng hợp máy cho CMS |
| | `GET` | `/api/admin/devices/{deviceId}/overview` | `devices:read` | Chi tiết toàn diện máy, phím, tiến độ |
| | `GET` | `/api/admin/audit-events` | `audit:read` | Lịch sử audit thô toàn hệ thống |
| | `GET` | `/api/admin/audit-summaries` | `audit:read` | Lịch sử audit làm giàu (tên máy, actor) |
| **Cấu hình Giờ & Mạng** | `GET` | `/api/admin/time-settings` | `devices:read` | Đọc cài đặt máy chủ SNTP toàn cục |
| | `PATCH` | `/api/admin/time-settings` | `policy:write` (OPERATOR) | Cập nhật cài đặt SNTP toàn cục |
| | `GET` | `/api/devices/{deviceId}/time-settings` | `DeviceBearer` | ESP32 đọc cấu hình SNTP để đồng bộ |
| | `GET` | `/api/admin/devices/{deviceId}/runtime-settings` | `devices:read` | CMS xem trạng thái mạng và giờ máy báo |
| | `PATCH` | `/api/admin/devices/{deviceId}/network-config` | `devices:write` | CMS lưu cấu hình Wi-Fi (đã mã hóa) |
| | `GET` | `/api/devices/{deviceId}/network-config` | `DeviceBearer` | ESP32 lấy Wi-Fi khi chạy APPLY_CONFIG |
| **Firmware & OTA** | `POST` | `/api/admin/firmware-releases` | `firmware:write` | Tạo bản phát hành firmware (manifest) |
| | `GET` | `/api/admin/firmware-releases` | `devices:read` | Danh sách bản phát hành firmware |
| | `GET` | `/api/admin/firmware-releases/{id}` | `devices:read` | Chi tiết bản phát hành firmware |
| | `PUT` | `/api/admin/firmware-releases/{id}/binary` | `firmware:write` | Upload file nhị phân .bin lên R2 |
| | `PATCH` | `/api/admin/firmware-releases/{id}` | `firmware:approve` | Duyệt (APPROVED) hoặc thu hồi bản firmware |
| | `PUT` | `/api/admin/devices/{deviceId}/firmware-target` | `devices:write` | Chỉ định bản firmware mục tiêu cho máy |
| | `GET` | `/api/devices/{deviceId}/firmware/{id}/manifest` | `DeviceBearer` | ESP32 đọc manifest firmware được chỉ định |
| | `GET` | `/api/devices/{deviceId}/firmware/{id}/binary` | `DeviceBearer` | ESP32 tải nhị phân OTA (hỗ trợ Range) |
| **Thiết bị HTTP & WS** | `GET` | `/api/devices/{deviceId}/desired-state` | `DeviceBearer` | ESP32 đọc trạng thái mong muốn |
| | `GET` | `/api/devices/{deviceId}/connection` | `DeviceBearer` | Kết nối WebSocket thời gian thực |

---

## 3. Chi tiết từng Endpoint

### 3.1. Nhóm Hệ thống & Check-in QR

#### `GET /health`
- **Mục đích:** Kiểm tra trạng thái hoạt động của Worker.
- **Input:** Không.
- **Output:** `200 OK`
  ```json
  { "status": "ok", "service": "vnfam-device-api" }
  ```

---

#### `GET /checkin`
- **Mục đích:** Xác thực chữ ký mã QR hiển thị tại cửa do ESP32 sinh ra. Chỉ kiểm tra chữ ký P-256 và thời hạn hiệu lực, không tạo phiên người chơi, không ghi nhận tem và không redirect.
- **Xác thực:** Công khai (Không cần header).
- **Rate Limit:** 120 req/phút theo IP (`CF-Connecting-IP`).
- **Input (Query Parameters - Bắt buộc đúng 4 tham số, không thừa thiếu):**
  - `v`: `"1"` (phiên bản giao thức).
  - `did`: Chuỗi ID thiết bị, regex `^[a-z0-9-]{1,32}$`.
  - `t`: Thời điểm sinh mã tính bằng giây Unix, làm tròn bội số 30s: `t = floor(nowSeconds / 30) * 30`.
  - `sig`: Chữ ký số Base64URL không padding (64 bytes raw IEEE P1363 `r || s`) ký trên chuỗi ASCII `v1.<did>.<t>`.
- **Output:**
  - `200 OK`:
    ```json
    {
      "valid": true,
      "deviceId": "door-1",
      "issuedAtMs": 1730000000000,
      "verifiedAtMs": 1730000005000
    }
    ```
  - `400 Bad Request`: `{"error":"bad_request"}` (thiếu/sai tham số hoặc `t` ở tương lai quá 5s).
  - `401 Unauthorized`: `{"error":"invalid_signature"}` (chữ ký sai hoặc máy chưa kích hoạt).
  - `404 Not Found`: `{"error":"unknown_device"}` (không tìm thấy `did`).
  - `410 Gone`: `{"error":"expired"}` (mã QR quá hạn TTL so với giờ server).
  - `429 Too Many Requests`: `{"error":"rate_limited"}`.
  - `503 Service Unavailable`: `{"error":"unavailable"}`.

---

#### `POST /api/check-ins`
- **Mục đích:** Dành cho Backend Minigame xác thực lượt có mặt thực tế của người chơi và tạo biên lai check-in (`Receipt`).
- **Xác thực:** `ServiceBearer` với quyền `checkins:write`.
- **Headers:** `Authorization`, `X-Actor-Id`, `Idempotency-Key`.
- **Input (JSON Body):**
  ```json
  {
    "subjectId": "user_12345",
    "subjectName": "Nguyễn Văn A",
    "scopeId": "museum_main",
    "qr": {
      "version": 1,
      "deviceId": "door_01",
      "scopeId": "museum_main",
      "keyId": "k_1234567890123456789012345678901234567890123",
      "issuedAtMs": 1730000000000,
      "signature": "abcdef...86-chars-base64url..."
    }
  }
  ```
  *(Chuỗi ký của QR format này là `CHECKIN_V1|<deviceId>|<scopeId>|<keyId>|<issuedAtMs>`)*.
- **Output:** `201 Created`
  ```json
  {
    "checkInId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "subjectId": "user_12345",
    "scopeId": "museum_main",
    "deviceId": "door_01",
    "qrIssuedAtMs": 1730000000000,
    "verifiedAtMs": 1730000003500
  }
  ```

---

#### `GET /api/check-ins/latest`
- **Mục đích:** Kiểm tra lượt check-in gần nhất còn hiệu lực của một người chơi trong một phân vùng.
- **Xác thực:** `ServiceBearer` với quyền `checkins:read`.
- **Query Parameters:**
  - `subjectId`: ID người chơi.
  - `scopeId`: ID phạm vi.
- **Output:** `200 OK`
  - Nếu đã check-in: Trả về đối tượng `Receipt` như trên.
  - Nếu chưa có: `null`.

---

#### `GET /api/admin/check-in-policy` & `PATCH /api/admin/check-in-policy`
- **Mục đích:** Đọc và cập nhật cửa sổ hợp lệ của mã QR toàn hệ thống.
- **Quyền:** `audit:read` cho GET; `policy:write` (chỉ role `OPERATOR`) cho PATCH.
- **Input Body (PATCH):**
  ```json
  {
    "maxAgeMs": 60000,
    "futureSkewMs": 5000
  }
  ```
  *(Ràng buộc: `maxAgeMs` từ 30,000 đến 60,000 ms; `futureSkewMs` từ 0 đến 5,000 ms)*.
- **Output:** `200 OK` `{ "maxAgeMs": 60000, "futureSkewMs": 5000 }`.

---

#### `GET /api/admin/check-in-summaries`
- **Mục đích:** CMS truy vấn danh sách lịch sử check-in có làm giàu tên hiển thị của thiết bị, người chơi và scope.
- **Quyền:** `audit:read`.
- **Query Parameters:** `cursor`, `limit` (1-100), `fromMs`, `toMs`, `deviceId`, `subjectId`, `siteId`, `scopeId`, `deviceName`, `subjectName`.
- **Output:** `200 OK`
  ```json
  {
    "items": [
      {
        "checkInId": "...",
        "subjectId": "user_123",
        "subjectName": "Nguyễn Văn A",
        "scopeId": "scope_01",
        "scopeName": "Cổng chính",
        "deviceId": "door_01",
        "deviceName": "Cửa Đông 1",
        "qrIssuedAtMs": 1730000000000,
        "verifiedAtMs": 1730000002000
      }
    ],
    "nextCursor": "checkin_id_tiep_theo_hoac_null"
  }
  ```

---

### 3.2. Nhóm Đăng ký & Ghép nối Thiết bị (ESP32 Onboarding & Pairing)

Quyết định ngày 05/11/2026: backend lưu public key trong D1 và tự xác nhận sau proof sở hữu khóa; CMS chỉ theo dõi đăng ký. Luồng là `CHALLENGE → COMPLETED`, không chờ admin. Proof chỉ chứng minh sở hữu private key, không xác minh thiết bị thuộc tổ chức; mọi thiết bị gọi được endpoint và vượt qua kiểm tra hiện có có thể đăng ký vào site/scope được cấu hình trên backend. Không dùng đăng ký mới để thay khóa hay credential của máy đã có. Recovery/rotation giữ xác thực hiện hành.

#### `POST /api/device-registrations`
- **Mục đích:** ESP32 khởi tạo phiên đăng ký; server lưu public key vào D1 `device_registrations` với state `CHALLENGE`, chưa cấp credential.
- **Xác thực:** Công khai.
- **Input (JSON Body):**
  ```json
  {
    "publicKey": "04a1b2c3...87_ky_tu_base64url_diem_uncompressed_p256...",
    "hardwareTarget": "esp32_wroom_32e",
    "serial": "SN-ESP32-00123"
  }
  ```
- **Output:** `201 Created`
  ```json
  {
    "registrationId": "reg_a1b2c3d4",
    "nonce": "random_43_chars_nonce...",
    "expiresAt": 1730000600000
  }
  ```
  *(ESP32 phải giữ kín `nonce` để dùng cho bước hoàn tất; phiên có hiệu lực 10 phút. CMS không được nhận nonce)*.

---

#### `POST /api/device-registrations/{registrationId}/complete`
- **Mục đích:** ESP32 gửi lại nonce bí mật và chữ ký chứng minh sở hữu private key (Proof of Possession). Khi hợp lệ, một transaction D1 tự tạo hồ sơ máy, cấp credential, lưu khóa `ACTIVE` vào `qr_keys` và chuyển đăng ký sang `COMPLETED`; tên ban đầu là serial đã trim hoặc `hardwareTarget` nếu serial trống.
- **Input (JSON Body):**
  ```json
  {
    "nonce": "random_43_chars_nonce...",
    "proof": "base64url_signature_86_chars..."
  }
  ```
  *(Message được ký chính xác UTF-8, không BOM/newline: `REGISTER_V1|<registrationId>|<nonce>|<keyId>`)*.
- **Output:** `201 Created`
  ```json
  {
    "deviceId": "door_01",
    "generation": 1,
    "keyId": "...",
    "token": "device_token_43_chars_base64url..."
  }
  ```
  *(ESP32 lưu `token`, `deviceId`, `generation` vào NVS bền vững trước khi kết nối. Token này dùng làm `DeviceBearer`; `confirmedAt` vẫn chờ `BOOT_REPORT` hợp lệ. Challenge chỉ hoàn tất một lần: gọi lại không tạo thêm máy hoặc trả lại token. Mất response cần recovery có xác thực trên hồ sơ thiết bị đã tạo)*.
- **Kiểm tra:** nonce sai không tăng số lần sai proof; nonce đúng nhưng proof sai đủ 5 lần khóa challenge. Hết hạn trả `410 REGISTRATION_EXPIRED`; challenge đã hoàn tất hoặc bị khóa trả lỗi `409`. Public key đã đăng ký không được gán sang máy mới.

---

#### `POST /api/admin/device-pairings`
- **Mục đích:** CMS tạo một phiên ghép nối khôi phục (Recovery Pairing) khi thiết bị cũ bị mất token hoặc cần đổi danh tính/khóa.
- **Quyền:** `pairings:write`.
- **Input (JSON Body):**
  ```json
  {
    "deviceId": "door_01",
    "replaceIdentity": false
  }
  ```
- **Output:** `201 Created`
  ```json
  {
    "pairingId": "pair_123",
    "deviceId": "door_01",
    "nonce": "...",
    "expiresAt": 1730000600000,
    "code": "one_time_pairing_code_43_chars...",
    "state": "PENDING"
  }
  ```

---

#### `POST /api/device-pairings/complete`
- **Mục đích:** ESP32 hoàn tất ghép nối khôi phục để nhận token mới.
- **Xác thực:** Công khai (Chứng minh bằng khóa và mã code).
- **Input (JSON Body):**
  ```json
  {
    "pairingId": "pair_123",
    "code": "one_time_pairing_code_43_chars...",
    "publicKey": "...",
    "proof": "..."
  }
  ```
  *(Message được ký: `PAIR_V1|<pairingId>|<deviceId>|<nonce>|<keyId>`)*.
- **Output:** `201 Created`
  ```json
  {
    "deviceId": "door_01",
    "generation": 2,
    "keyId": "...",
    "token": "new_device_token_43_chars..."
  }
  ```

---

### 3.3. Nhóm Quản trị Thiết bị (Device Management)

#### `GET /api/admin/devices`
- **Mục đích:** Xem danh sách thiết bị thuộc phạm vi của token quản trị.
- **Quyền:** `devices:read`.
- **Query Parameters:** `cursor` (string), `limit` (1-100, mặc định 25).
- **Output:** `200 OK`
  ```json
  {
    "items": [
      {
        "deviceId": "door_01",
        "name": "Cổng soát vé 1",
        "siteId": "museum_01",
        "doorId": "door_01",
        "scopeId": "museum_main",
        "qrBaseUrl": "https://devices.castorice.tech/checkin",
        "checkInEnabled": true,
        "generation": 1,
        "pairedAt": 1730000000000,
        "confirmedAt": 1730000050000,
        "configRevision": 2,
        "appliedRevision": 2,
        "firmwareTarget": null,
        "bootId": "boot_123",
        "hardwareTarget": "esp32_board_01",
        "firmwareVersion": "1.0.0",
        "buildId": "bld_987",
        "otaSlotBytes": 2097152,
        "capabilities": ["REQUEST_STATUS", "APPLY_CONFIG", "REBOOT", "UPGRADE_FIRMWARE"],
        "lastSeenAt": 1730000100000,
        "createdAt": 1729990000000
      }
    ],
    "nextCursor": null
  }
  ```

---

#### `GET /api/admin/devices/{deviceId}`
- **Mục đích:** Xem chi tiết một thiết bị kèm trạng thái kết nối trực tiếp (`online: boolean`).
- **Quyền:** `devices:read`.
- **Output:** `200 OK` Đối tượng `Device` kèm trường `"online": true | false`.

---

#### `PATCH /api/admin/devices/{deviceId}`
- **Mục đích:** Cập nhật thông tin hồ sơ thiết bị (tên, phân vùng, bật/tắt tiếp nhận check-in).
- **Quyền:** `devices:write`.
- **Headers:** `Authorization`, `X-Actor-Id`, `Idempotency-Key`.
- **Input (JSON Body - Tùy chọn các trường):**
  ```json
  {
    "name": "Cửa soát vé Tây 2",
    "siteId": "museum_01",
    "doorId": "door_w2",
    "checkInEnabled": true
  }
  ```
- **Output:** `200 OK` Đối tượng `Device` đã cập nhật.

---

#### `DELETE /api/admin/devices/{deviceId}`
- **Mục đích:** Xóa thiết bị khỏi danh sách hoạt động, thu hồi token quản lý, hủy bỏ các khóa QR còn hiệu lực, hủy pairing dở dang, xóa cấu hình Wi-Fi. Dữ liệu lịch sử audit và check-in vẫn được lưu giữ.
- **Quyền:** `devices:write` và `credentials:revoke`.
- **Output:** `200 OK` `{ "ok": true }`.

---

#### `GET /api/admin/devices/{deviceId}/config` & `PATCH /api/admin/devices/{deviceId}/config`
- **Mục đích:** Đọc và cập nhật cấu hình mong muốn (desired config) của thiết bị (URL QR, Scope).
- **Quyền:** `devices:read` cho GET; `devices:write` cho PATCH.
- **Input Body (PATCH):**
  ```json
  {
    "revision": 2,
    "scopeId": "scope_new",
    "qrBaseUrl": "https://devices.castorice.tech/checkin"
  }
  ```
  *(Cơ chế Optimistic Concurrency: `revision` gửi lên phải bằng đúng `configRevision` hiện tại của máy; khi lưu thành công server sẽ tăng lên 1)*.
- **Output:** `200 OK`
  ```json
  {
    "revision": 3,
    "scopeId": "scope_new",
    "qrBaseUrl": "https://devices.castorice.tech/checkin",
    "appliedRevision": 2
  }
  ```

---

#### `POST /api/admin/devices/{deviceId}/commands`
- **Mục đích:** Gửi lệnh quản trị tới ESP32 đang kết nối WebSocket (nếu máy offline, lệnh trả về lỗi và không xếp hàng).
- **Quyền:** `commands:write`.
- **Headers:** `Authorization`, `X-Actor-Id`, `Idempotency-Key`.
- **Input (JSON Body):**
  ```json
  {
    "action": "SYNC_TIME"
  }
  ```
  *Danh sách action hỗ trợ:*
  - `REQUEST_STATUS`: Yêu cầu gửi báo cáo trạng thái `BOOT_REPORT`.
  - `SYNC_TIME`: Yêu cầu đồng bộ lại đồng hồ SNTP.
  - `APPLY_CONFIG`: Yêu cầu kéo cấu hình Wi-Fi/URL mới và áp dụng.
  - `REBOOT`: Khởi động lại thiết bị.
  - `RESET_WIFI`: Xóa thông tin Wi-Fi đã lưu trên ESP32.
  - `SCAN_WIFI`: Quét danh sách các mạng Wi-Fi xung quanh.
  - `ROTATE_QR_KEY`: Yêu cầu tạo cặp khóa QR mới.
- **Output:** `202 Accepted`
  ```json
  {
    "operationId": "op_12345678",
    "deviceId": "door_01",
    "generation": 1,
    "action": "SYNC_TIME",
    "source": "ADMIN",
    "state": "SENT",
    "createdAt": 1730000000000,
    "deadline": 1730000060000,
    "ackDeadline": 1730000015000,
    "payload": {},
    "result": null,
    "actorId": "admin_user_01",
    "clientId": "cms"
  }
  ```

---

#### `POST /api/admin/devices/{deviceId}/upgrades`
- **Mục đích:** Gửi lệnh nâng cấp OTA firmware cho thiết bị.
- **Quyền:** `commands:write`.
- **Input (JSON Body):**
  ```json
  {
    "releaseId": "rel_v1_0_1"
  }
  ```
- **Output:** `202 Accepted` Đối tượng `Operation` với `action: "UPGRADE_FIRMWARE"`.

---

#### `GET /api/admin/devices/{deviceId}/operations` & `GET /api/admin/devices/{deviceId}/operations/{operationId}`
- **Mục đích:** Tra cứu lịch sử thao tác hoặc xem trạng thái thực thi hiện tại của một lệnh (`CREATED`, `SENT`, `ACKNOWLEDGED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `EXPIRED`).
- **Quyền:** `devices:read`.
- **Output:** `200 OK` Danh sách hoặc chi tiết `Operation`.

---

### 3.4. Nhóm Tổng hợp CMS (CMS Summaries & Context)

#### `GET /api/admin/context`
- **Mục đích:** Lấy thông tin ngữ cảnh bảo mật của token CMS đang sử dụng (danh sách sites, scopes, permissions được cấp và giờ server).
- **Quyền:** `devices:read`.
- **Output:** `200 OK`
  ```json
  {
    "clientId": "cms",
    "sites": ["museum_01"],
    "scopes": ["museum_main"],
    "permissions": ["devices:read", "devices:write", "commands:write"],
    "serverTimeMs": 1730000000000
  }
  ```

---

#### `GET /api/admin/device-summaries`
- **Mục đích:** CMS hiển thị danh sách thiết bị kèm snapshot trạng thái kết nối (`ONLINE`, `OFFLINE`, `UNKNOWN`), tình trạng danh tính (`UNPAIRED`, `AWAITING_BOOT`, `CONFIRMED`, `REPAIR_REQUIRED`) và tác vụ đang chạy (`activeOperation`) mà không cần query đồng loạt sang các Durable Object.
- **Quyền:** `devices:read`.
- **Query Parameters:** `q` (tìm kiếm tên/ID), `siteId`, `scopeId`, `identity`, `accepting` (`true`/`false`), `connection` (`ONLINE`/`OFFLINE`/`UNKNOWN`), `limit`, `cursor`.
- **Output:** `200 OK` `{ "items": [Summary], "nextCursor": ... }`.

---

#### `GET /api/admin/devices/{deviceId}/overview`
- **Mục đích:** Màn hình chi tiết toàn diện của một thiết bị trên CMS.
- **Quyền:** `devices:read`.
- **Output:** `200 OK` Trả về `Overview` bao gồm:
  - Thông tin thiết bị (`device`).
  - Trạng thái kết nối (`connection`) & định danh (`identity`).
  - Cấu hình mong muốn & áp dụng (`config`).
  - Phiên pairing gần nhất (`pairing`).
  - Danh sách các khóa QR đã đăng ký (`keys`).
  - 10 thao tác gần nhất kèm phần trăm tiến độ nếu có (`recentOperations`).
  - Thời điểm đồng bộ SNTP thành công gần nhất (`lastSyncedAtMs`).
  - Thời gian server (`serverTimeMs`).

---

### 3.5. Nhóm Cấu hình Thời gian & Wi-Fi (Runtime Settings)

#### `GET /api/admin/time-settings` & `PATCH /api/admin/time-settings`
- **Mục đích:** Đọc và cập nhật máy chủ SNTP và múi giờ dùng chung toàn hệ thống.
- **Quyền:** `devices:read` cho GET; `policy:write` (role `OPERATOR`) cho PATCH.
- **Input Body (PATCH):**
  ```json
  {
    "revision": 1,
    "server": "time.google.com",
    "timezone": "Asia/Ho_Chi_Minh"
  }
  ```
- **Output:** `200 OK`
  ```json
  {
    "revision": 2,
    "server": "time.google.com",
    "timezone": "Asia/Ho_Chi_Minh",
    "protocol": "SNTP"
  }
  ```

---

#### `GET /api/devices/{deviceId}/time-settings`
- **Mục đích:** Thiết bị ESP32 gọi endpoint này trước mỗi lần tự động đồng bộ giờ qua SNTP.
- **Xác thực:** `DeviceBearer`.
- **Output:** `200 OK` Thông tin `TimeSettings` như trên.

---

#### `GET /api/admin/devices/{deviceId}/runtime-settings`
- **Mục đích:** CMS xem cấu hình mạng hiện tại (chỉ thấy tên SSID, cờ `passwordConfigured: true/false`, không hiển thị mật khẩu) và trạng thái giờ thiết bị báo về (`status.time`).
- **Quyền:** `devices:read`.
- **Output:** `200 OK`
  ```json
  {
    "network": {
      "revision": 2,
      "appliedRevision": 2,
      "ssid": "Museum_Staff_WiFi",
      "passwordConfigured": true
    },
    "time": {
      "revision": 2,
      "server": "time.google.com",
      "timezone": "Asia/Ho_Chi_Minh",
      "protocol": "SNTP"
    },
    "status": {
      "observedAt": 1730000000000,
      "runtimeConfigVersion": 1,
      "wifiSsid": "Museum_Staff_WiFi",
      "time": {
        "server": "time.google.com",
        "configRevision": 2,
        "deviceTimeMs": 1730000000000,
        "syncedAtMs": 1729999000000,
        "status": "SYNCED"
      }
    }
  }
  ```

---

#### `PATCH /api/admin/devices/{deviceId}/network-config`
- **Mục đích:** CMS cập nhật cấu hình Wi-Fi mới cho thiết bị. Mật khẩu được mã hóa bảo mật AES-GCM 256-bit với `CONFIG_ENCRYPTION_KEY` trước khi lưu vào D1.
- **Quyền:** `devices:write`.
- **Headers:** `Authorization`, `X-Actor-Id`, `Idempotency-Key`.
- **Input (JSON Body):**
  ```json
  {
    "revision": 2,
    "ssid": "Museum_Staff_WiFi",
    "password": "SecretWiFiPassword123"
  }
  ```
  *(Nếu chỉ đổi cấu hình khác mà giữ nguyên mật khẩu cũ, có thể không truyền trường `password`)*.
- **Output:** `200 OK`
  ```json
  {
    "revision": 3,
    "appliedRevision": 2,
    "ssid": "Museum_Staff_WiFi",
    "passwordConfigured": true
  }
  ```

---

#### `GET /api/devices/{deviceId}/network-config`
- **Mục đích:** ESP32 lấy cấu hình SSID và mật khẩu dạng rõ để nạp vào chip Wi-Fi. Endpoint này **chỉ cho phép truy cập** khi thiết bị đang ở trong trạng thái thực thi lệnh `APPLY_CONFIG` hợp lệ.
- **Xác thực:** `DeviceBearer`.
- **Query Parameter:**
  - `operationId`: ID của tác vụ `APPLY_CONFIG` tương ứng.
- **Output:** `200 OK`
  ```json
  {
    "revision": 3,
    "ssid": "Museum_Staff_WiFi",
    "password": "SecretWiFiPassword123"
  }
  ```

---

### 3.6. Nhóm Quản lý Firmware & OTA (Firmware Releases)

#### `POST /api/admin/firmware-releases`
- **Mục đích:** Đăng ký metadata manifest của bản phát hành firmware mới (phải có chữ ký số của Publisher Key).
- **Quyền:** `firmware:write`.
- **Input (JSON Body):**
  ```json
  {
    "releaseId": "rel_v1_0_1",
    "buildId": "build_20261105_01",
    "hardwareTarget": "esp32_board_01",
    "version": "1.0.1",
    "size": 1548288,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "publisherKeyId": "pub_key_id_43_chars...",
    "signature": "publisher_signature_86_chars..."
  }
  ```
- **Output:** `201 Created` Trả về `Release` với `state: "UPLOADING"`, `verified: false`.

---

#### `PUT /api/admin/firmware-releases/{releaseId}/binary`
- **Mục đích:** Upload file nhị phân firmware `.bin` lên Cloudflare R2. Server tự tính toán lại SHA-256 stream và đối chiếu kích thước, nếu khớp sẽ tự động chuyển `state` sang `DRAFT` và đánh dấu `verified: true`.
- **Quyền:** `firmware:write`.
- **Headers:** `Content-Type: application/octet-stream`, `Content-Length: <dung-luong-file>`.
- **Body:** Binary Stream (tối đa 8 MiB).
- **Output:** `200 OK` `{ "ok": true }`.

---

#### `PATCH /api/admin/firmware-releases/{releaseId}`
- **Mục đích:** Người có thẩm quyền phê duyệt bản firmware đã upload (`APPROVED`) để sẵn sàng gán cho máy, hoặc thu hồi (`REVOKED`).
- **Quyền:** `firmware:approve`.
- **Input (JSON Body):**
  ```json
  {
    "state": "APPROVED"
  }
  ```
- **Output:** `200 OK` `Release`.

---

#### `PUT /api/admin/devices/{deviceId}/firmware-target`
- **Mục đích:** Chỉ định bản firmware đã duyệt cho một thiết bị cụ thể (chưa dispatch lệnh OTA).
- **Quyền:** `devices:write`.
- **Input (JSON Body):**
  ```json
  {
    "releaseId": "rel_v1_0_1"
  }
  ```
- **Output:** `200 OK` `{ "releaseId": "rel_v1_0_1" }`.

---

#### `GET /api/devices/{deviceId}/firmware/{releaseId}/manifest`
- **Mục đích:** ESP32 đọc manifest của bản firmware đã được gán để chuẩn bị vùng nhớ partition OTA.
- **Xác thực:** `DeviceBearer`.
- **Output:** `200 OK` Đối tượng `Manifest`.

---

#### `GET /api/devices/{deviceId}/firmware/{releaseId}/binary`
- **Mục đích:** ESP32 tải nhị phân firmware từ R2 để tiến hành ghi đè flash.
- **Xác thực:** `DeviceBearer`.
- **Headers hỗ trợ:** `Range: bytes=start-end` (cho phép tải từng đoạn hoặc khôi phục tải khi mất kết nối giữa chừng).
- **Output:**
  - `200 OK`: Toàn bộ binary stream (`Accept-Ranges: bytes`, `Content-Length`, `ETag`).
  - `206 Partial Content`: Đoạn nhị phân theo Range yêu cầu (`Content-Range: bytes start-end/total`).
  - `416 Range Not Satisfiable`: Dải byte không hợp lệ.

---

### 3.7. Nhóm Thiết bị: State & WebSocket (Device Runtime)

#### `GET /api/devices/{deviceId}/desired-state`
- **Mục đích:** ESP32 đọc trạng thái mong muốn từ server (cấu hình, bản firmware target, thời gian server và thao tác đang chờ xử lý).
- **Xác thực:** `DeviceBearer`.
- **Output:** `200 OK`
  ```json
  {
    "deviceId": "door_01",
    "generation": 1,
    "config": {
      "revision": 2,
      "scopeId": "museum_main",
      "qrBaseUrl": "https://devices.castorice.tech/checkin",
      "appliedRevision": 2
    },
    "firmwareTarget": "rel_v1_0_1",
    "serverTimeMs": 1730000000000,
    "activeOperation": null
  }
  ```

---

#### `GET /api/devices/{deviceId}/connection` (WebSocket Upgrade)
- **Mục đích:** ESP32 duy trì kênh liên lạc hai chiều theo thời gian thực với Durable Object quản lý thiết bị.
- **Xác thực:** `Authorization: Bearer <device-token>`.
- **Headers:** `Upgrade: websocket`, `Connection: Upgrade`.
- **Output:** `101 Switching Protocols`.

##### Luồng bản tin WebSocket:
1. **Server gửi ngay sau khi nối:**
   ```json
   {
     "version": 1,
     "type": "WELCOME",
     "eventId": "evt_uuid",
     "payload": {
       "sessionId": "sess_uuid",
       "generation": 1,
       "serverTimeMs": 1730000000000
     }
   }
   ```
2. **ESP32 gửi báo cáo khởi động (Bắt buộc để được tính là Online):**
   ```json
   {
     "version": 1,
     "type": "BOOT_REPORT",
     "eventId": "evt_boot_1",
     "payload": {
       "bootId": "boot_random_id",
       "keyId": "k_dang_dung...",
       "hardwareTarget": "esp32_board_01",
       "firmwareVersion": "1.0.0",
       "buildId": "bld_01",
       "otaSlotBytes": 2097152,
       "capabilities": ["REQUEST_STATUS", "APPLY_CONFIG", "REBOOT", "UPGRADE_FIRMWARE"],
       "appliedRevision": 2,
       "healthy": true,
       "runtimeConfigVersion": 1,
       "wifiSsid": "Museum_WiFi"
     }
   }
   ```
3. **Server gửi lệnh (COMMAND):**
   ```json
   {
     "version": 1,
     "type": "COMMAND",
     "eventId": "evt_cmd_1",
     "operationId": "op_12345",
     "payload": {
       "action": "SYNC_TIME",
       "deadline": 1730000060000,
       "parameters": {}
     }
   }
   ```
4. **ESP32 phản hồi tiến trình & kết quả:**
   - Xác nhận nhận lệnh: Gửi `type: "COMMAND_ACK"`.
   - Cập nhật tiến độ: Gửi `type: "COMMAND_PROGRESS"` kèm `payload: { "progress": 50 }`.
   - Báo cáo kết quả hoàn thành: Gửi `type: "COMMAND_RESULT"` kèm `payload: { "success": true, ... }`.
5. **Heartbeat:** ESP32 gửi raw text `"ping"` mỗi 30 giây, server tự động phản hồi raw text `"pong"`.
