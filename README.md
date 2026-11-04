# VNFAM — quản trị thiết bị ESP32

Hệ thống quản lý các máy phát QR tại đầu vào bảo tàng. ESP32 tự tạo khóa, đổi QR mỗi 30 giây; backend xác minh QR để backend minigame xác nhận lượt check-in. CMS dành cho người quản trị thiết bị, không có giao diện người chơi hoặc cơ chế trao thưởng.

## Hệ thống có gì

- **Thiết bị:** ESP32 gửi yêu cầu đăng ký, CMS duyệt và đặt tên/vị trí. Xem kết nối, bật/tắt tiếp nhận check-in, cấu hình và lịch sử. Xóa máy sẽ thu hồi quyền kết nối/khóa QR, ẩn khỏi danh sách đang dùng; lịch sử được giữ lại.
- **Bảo trì:** quét/chọn Wi-Fi nếu firmware hỗ trợ, lưu/áp dụng cấu hình, lấy trạng thái, khởi động lại, xóa Wi-Fi, đổi khóa QR và flash firmware cho một máy.
- **Cài đặt chung:** SNTP/múi giờ, chính sách xác minh QR và tải firmware để cập nhật các máy được chọn.
- **Check-in và Nhật ký:** xem lượt đã xác nhận, tên tương ứng với Subject / Scope, tên máy và hành động quản trị. ID phục vụ tra cứu nằm trong phần thu gọn.

Backend dùng TypeScript, Hono, Cloudflare Workers; D1 lưu dữ liệu, mỗi máy có một Durable Object quản lý kết nối/lệnh, R2 private chứa firmware. CMS dùng React/Vite và một Hono bridge gọi backend qua Service Binding. Service token chỉ nằm ở server.

Bun quản lý dependency và chạy lệnh; Node chạy bên trong Wrangler và một số công cụ. Worker production chạy bằng workerd. Dự án không chứa mã firmware ESP32 hoặc hệ thống đăng nhập riêng; khi ghép vào CMS tổng, nối nguồn actor của bridge với người dùng đã được CMS xác thực.

## Cài và chạy local

Cần Bun từ 1.4.4 và Node 24 LTS.

```sh
bun install --frozen-lockfile
bun run dev:cms
```

Mở `http://127.0.0.1:8788`. Lệnh này build CMS/Worker rồi khởi động một môi trường local tạm, có credential vận hành nội bộ nhưng chưa có thiết bị. Dữ liệu không được giữ khi dừng. Firmware thử cùng CMS này dùng API tại `http://127.0.0.1:8788/api` và WebSocket cùng host; không trỏ sang database local riêng ở cổng 8787.

Chạy riêng API với D1 local lưu bền:

```sh
bun run db:init
bun run dev
```

API ở `http://127.0.0.1:8787`; `/health` kiểm tra dịch vụ và `/openapi.json` cung cấp OpenAPI hiện hành. `db:init` chỉ chạy một lần trên database trắng. `schema.sql` chứa các bảng/index/cấu hình mặc định trực tiếp, không chứa credential hoặc thiết bị mẫu. Không import lại vào database đã có dữ liệu.

```sh
bun run typecheck
bun run typecheck:cms
bun run build
bun run build:cms
```

Hai lệnh build chỉ kiểm tra/đóng gói local, không triển khai cloud.

## Triển khai Cloudflare

Có hai Worker: API thiết bị và CMS/bridge. CMS nối đến API bằng Service Binding; chỉ các thiết bị cần hostname API/WSS công khai.

Cấu hình local nằm ở `wrangler.jsonc` và `cms/wrangler.jsonc`; cấu hình cloud hiện tại nằm ở `wrangler.staging.jsonc` và `cms/wrangler.staging.jsonc`. Khi dùng tài khoản/môi trường khác, đổi account, hostname, Worker name, D1 ID, R2 bucket và Service Binding cho khớp trước khi triển khai.

1. Đăng nhập bằng `bunx wrangler login`. Tạo D1/R2 cho môi trường mới nếu chưa có, rồi điền binding `DB` và `FIRMWARE` vào config API.
2. Khởi tạo **D1 trắng** bằng một file:

    ```sh
    bunx wrangler d1 execute DB --remote --config wrangler.staging.jsonc --file schema.sql
    ```

3. Đặt cùng `REGISTRATION_SITE_ID` / `REGISTRATION_SCOPE_ID` ở API và `CMS_SITE_ID` / `CMS_SCOPE_ID` ở CMS. `REGISTRATION_SCOPE_NAME` là tên hiển thị. Đây là phạm vi hệ thống cấp cho các máy đăng ký, không phải trường người vận hành phải nhập từng máy.
4. Tạo `CONFIG_ENCRYPTION_KEY` ngẫu nhiên 32 byte, mã hóa Base64URL không padding và giữ trong secret store. Đưa vào Worker API qua prompt hoặc stdin/file được bảo vệ:

    ```sh
    bunx wrangler secret put CONFIG_ENCRYPTION_KEY --config wrangler.staging.jsonc
    ```

    Giữ nguyên khóa này qua các lần deploy để còn giải mã được Wi-Fi đã lưu.

5. Cấp credential CMS như phần bên dưới; đặt token vào secret `CMS_SERVICE_TOKEN` của Worker CMS. Nếu cần sửa SNTP/chính sách QR, cấp credential OPERATOR riêng có `policy:write` và đặt vào `CMS_POLICY_SERVICE_TOKEN`.

    ```sh
    bunx wrangler secret put CMS_SERVICE_TOKEN --config cms/wrangler.staging.jsonc
    bunx wrangler secret put CMS_POLICY_SERVICE_TOKEN --config cms/wrangler.staging.jsonc
    ```

6. Đặt `CMS_ORIGIN` đúng origin giao diện; `CMS_ACTOR_ID` / `CMS_ACTOR_NAME` là actor do server xác nhận. Với vận hành thật, bảo vệ hostname CMS bằng cổng truy cập của tổ chức và nối actor của CMS host. Giá trị `CMS_MODE=protected` chỉ khai báo chế độ, không tự tạo đăng nhập hoặc Cloudflare Access.
7. Build và deploy API trước CMS:

    ```sh
    bun run build
    bun run build:cms
    bun run deploy:staging
    bun run deploy:cms:staging
    ```

Môi trường thử hiện có:

- CMS: <https://cms-staging.castorice.tech/devices>
- API: <https://devices-staging.castorice.tech>
- OpenAPI: <https://devices-staging.castorice.tech/openapi.json>

CMS staging đang mở công khai theo cấu hình thử nghiệm; người truy cập có thể dùng quyền quản trị thử của bridge. Không dùng chế độ này với dữ liệu/thiết bị vận hành thật.

## Cấp credential cho CMS và backend minigame

Tạo file JSON local, ví dụ `.local/service.json`. Không đưa secret vào file mô tả quyền:

```json
{
    "credentialId": "cms_service_01",
    "clientId": "cms",
    "kind": "CMS",
    "permissions": [
        "devices:read",
        "devices:write",
        "pairings:write",
        "commands:write",
        "credentials:revoke",
        "keys:revoke",
        "firmware:write",
        "firmware:approve",
        "audit:read"
    ],
    "sites": ["staging_site"],
    "scopes": ["staging_scope"]
}
```

```sh
bun run provision service:create .local/service.json staging
```

Bỏ `staging` để cấp trên D1 local. Token ngẫu nhiên được ghi đúng một lần vào `.local/staging-<credentialId>.secret.json` hoặc `.local/<credentialId>.secret.json`; D1 chỉ lưu hash. Chuyển token sang secret store của bên dùng, không commit, đưa xuống browser, đặt trong URL hoặc argument.

- Minigame dùng `kind: "MINIGAME"`, quyền `checkins:write` và `checkins:read`.
- Chính sách QR/SNTP dùng `kind: "OPERATOR"`, quyền `policy:write`.
- Thu hồi service: file `{ "credentialId": "..." }`, chạy `bun run provision service:revoke <file.json> staging`.
- Khóa public nhà phát hành firmware: file `{ "publicKey": "<raw-32-byte-base64url>" }`, chạy `bun run provision publisher:add <file.json> staging`. Backend không giữ private key ký firmware.

Mọi request S2S gửi `Authorization: Bearer <token>` và `X-Actor-Id: <ASCII-ID>`. Mutation thêm `Idempotency-Key` ổn định cho một ý định. Không đổi key khi retry cùng nội dung; key cũ với nội dung khác trả `409 IDEMPOTENCY_CONFLICT`. Có thể gửi `X-Actor-Name` dạng percent-encoded để lưu nhãn hiển thị; tên không cấp thêm quyền.

## Đội firmware: bắt đầu kết nối ESP32

Wi-Fi ban đầu, TLS, SNTP, sinh/giữ khóa và lưu NVS do firmware triển khai. Không cần flash riêng mã pairing cho từng máy trong luồng đăng ký chính.

### 1. Đăng ký và chờ CMS duyệt

ESP32 tự sinh cặp **Pure Ed25519**, giữ private key trên máy. Public key raw 32 byte và signature raw 64 byte dùng Base64URL không padding. `keyId = Base64URL(SHA-256(rawPublicKey))`.

| Bước                   | Request                                                                                              | Kết quả                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tạo yêu cầu            | `POST /api/device-registrations` với `{publicKey,hardwareTarget,serial?}`                            | `{registrationId,nonce,claimSecret,expiresAt}`; lưu kín trước khi tiếp tục |
| Chứng minh sở hữu khóa | `POST /api/device-registrations/:registrationId/submit` với `{claimSecret,proof}`                    | CMS thấy yêu cầu `PENDING`                                                 |
| Chờ duyệt              | `POST /api/device-registrations/:registrationId/status` với `{claimSecret}`                          | Theo dõi state; poll không nhanh hơn 2 giây/lần                            |
| Nhận quyền             | Khi `APPROVED`, gọi `POST /api/device-registrations/:registrationId/claim` với `{claimSecret,proof}` | `{deviceId,generation,keyId,token}` đúng một lần                           |

Ký chính xác UTF-8, không BOM/newline:

```text
REGISTER_SUBMIT_V1|<registrationId>|<nonce>|<keyId>
REGISTER_CLAIM_V1|<registrationId>|<nonce>|<keyId>
```

Admin mở **Thiết bị → Thiết bị chờ duyệt**, đối chiếu máy và nhập tên/vị trí để duyệt. Secret/token không hiện trong CMS. Phiên hết hạn sau 10 phút; state có `CHALLENGE`, `PENDING`, `APPROVED`, `CLAIMED`, `REJECTED`, `LOCKED`, `EXPIRED`. Sai proof đủ 5 lần bị khóa.

Lưu bền token/deviceId/generation trước khi kết nối. Mất response sau claim không được tự xin token khác; admin dùng **Khôi phục ghép nối** trên hồ sơ hiện có. Mất mạng đơn thuần dùng lại identity, không đăng ký máy mới. Schema đầy đủ: `src/registration-contracts.ts`; pairing phục hồi: `/api/device-pairings/complete` trong OpenAPI.

### 2. WebSocket và BOOT

Mở `wss://<api-host>/api/devices/<deviceId>/connection` với header `Authorization: Bearer <device-token>`. Không đặt token trong URL. Local dùng `ws://`. Chờ `WELCOME` rồi gửi:

```json
{
    "version": 1,
    "type": "BOOT_REPORT",
    "eventId": "event_01",
    "payload": {
        "bootId": "boot_01",
        "keyId": "<keyId-da-dang-ky>",
        "hardwareTarget": "esp32_board_01",
        "firmwareVersion": "1.0.0",
        "buildId": "build_01",
        "otaSlotBytes": 2097152,
        "capabilities": ["REQUEST_STATUS", "APPLY_CONFIG", "REBOOT", "UPGRADE_FIRMWARE"],
        "appliedRevision": 0,
        "healthy": true,
        "runtimeConfigVersion": 1
    }
}
```

`hardwareTarget` phải thống nhất với bản firmware/manifest. Chỉ khai capabilities đã thực hiện. Giữ `bootId` khi reconnect cùng lần boot; tạo mới sau reboot. Chỉ BOOT hợp lệ mới xác nhận máy kết nối; không dùng public key tự khai trong BOOT để thay khóa tin cậy.

- Gửi text `ping` mỗi 30 giây, server trả `pong`. JSON WS tối đa 16 KiB; chỉ một session hiện hành cho mỗi máy.
- Mỗi bản tin JSON có `version`, `type`, `eventId`, `payload`; bản tin lệnh/kết quả có `operationId`.
- Lưu bền event/result đến khi nhận `EVENT_ACK` có `payload.eventId` tương ứng. Retry giữ nguyên eventId và nội dung.
- Sau reconnect: gửi BOOT hiện tại, đọc desired state và đối chiếu journal, gửi lại result chưa được ACK. Không chạy lại side effect chỉ vì mất ACK.
- Close `4001`: session bị thay/thu hồi; `1008`: JSON/schema sai; `1009`: quá kích thước; `1003`: binary không hỗ trợ; `1013`: quá tần suất. Reconnect có backoff/jitter, xử lý credential bị thu hồi thay vì lặp vô hạn.

Nguồn schema WS: `DeviceMessage`, `ServerMessage`, `Boot`, `Result` trong `src/contracts.ts`.

### 3. QR, giờ và check-in

Trước TLS lần đầu có thể cần bootstrap SNTP bằng `vn.pool.ntp.org`. Sau khi có credential, đọc `GET /api/devices/:deviceId/time-settings` trước mỗi lần tự đồng bộ: `{protocol:"SNTP",server,revision,timezone}`. Mặc định múi giờ `Asia/Ho_Chi_Minh` (UTC+7). SNTP đồng bộ UTC; múi giờ chỉ đổi hiển thị, **không cộng 7 giờ vào epoch ký QR**.

Đọc `GET /api/devices/:deviceId/desired-state` để lấy `config:{revision,scopeId,qrBaseUrl,appliedRevision}`, firmware target và operation đang đối chiếu. Đổi QR mỗi 30 giây:

```text
issuedAtMs = floor(nowMs / 30000) * 30000
CHECKIN_V1|<deviceId>|<scopeId>|<keyId>|<issuedAtMs>
```

Ký dòng trên bằng Ed25519. QR chứa `{version:1,deviceId,scopeId,keyId,issuedAtMs,signature}`. `qrBaseUrl` hiện rỗng: phát JSON đã ký, chưa redirect. Khi tích hợp có URL HTTPS, dùng URL đó với các trường QR làm query parameters. Backend nhận các trường đã tách, không fetch URL.

Backend minigame gọi `POST /api/check-ins` bằng credential của mình:

```json
{
    "subjectId": "subject_01",
    "subjectName": "Đối tượng hiển thị",
    "scopeId": "staging_scope",
    "qr": {
        "version": 1,
        "deviceId": "<deviceId>",
        "scopeId": "staging_scope",
        "keyId": "<keyId>",
        "issuedAtMs": 0,
        "signature": "<signature>"
    }
}
```

Thay timestamp/chữ ký bằng dữ liệu hiện tại. Cửa sổ mặc định: QR không cũ quá 35 giây, không vượt tương lai quá 5 giây. Nhiều subject dùng chung QR được. Kết quả trả bản xác nhận với `checkInId` và thời điểm, không trả quyền chơi/nhận thưởng. `subjectName` là tên CMS hiển thị trong **Subject / Scope**; thiếu tên thì hiện chưa có tên. Scope có tên từ cấu hình server.

### 4. Cấu hình, lệnh và OTA

Server gửi `COMMAND` với `{operationId,payload:{action,deadline,parameters}}`. Firmware lưu journal trước side effect, gửi `COMMAND_ACK`, thực hiện rồi gửi `COMMAND_RESULT`; progress thực có thể gửi `COMMAND_PROGRESS`. HTTP 202/ACK/100% progress không phải hoàn tất.

| Action             | Bằng chứng kết quả                                                          |
| ------------------ | --------------------------------------------------------------------------- |
| `REQUEST_STATUS`   | `DEVICE_STATUS` mới cùng operationId                                        |
| `APPLY_CONFIG`     | Applied revision đúng; có Wi-Fi thì thêm runtimeConfigVersion/wifiSsid đúng |
| `REBOOT`           | BOOT có bootId mới, sau đó result đối chiếu                                 |
| `RESET_WIFI`       | Result có `wifiCleared:true`; mất socket không đủ                           |
| `SCAN_WIFI`        | Result chứa scannedAtMs và wifiNetworks thực đo                             |
| `UPGRADE_FIRMWARE` | BOOT build đích/healthy và result cùng bootId/buildId/healthy               |

`UNKNOWN` nghĩa là chưa xác định kết quả, vẫn chặn lệnh xung đột. Khi reconnect, đọc `activeOperation` trong desired state và đối chiếu journal. Chỉ báo `NOT_EXECUTED` khi lưu bền chứng minh chưa chạy; không tự thực thi lại thao tác chưa rõ.

Wi-Fi được CMS lưu và áp dụng riêng. Máy khai `runtimeConfigVersion:1`; `APPLY_CONFIG` không mang password. Tải `GET /api/devices/:deviceId/network-config?operationId=...` bằng token máy để nhận `{revision,ssid,password}` đúng operation. Giữ mạng cũ để khôi phục, chỉ báo thành công sau khi nối lại backend bằng mạng mới. Khai `SCAN_WIFI` khi có thể quét SSID/RSSI/bảo mật; kết quả theo `WifiScan` trong `src/contracts.ts`.

Nút local gửi `LOCAL_REQUEST` với `payload:{action:"APPLY_CONFIG"}` hoặc `UPGRADE_FIRMWARE`, rồi chờ `COMMAND`. Backend chọn cấu hình/firmware đã được cấp, không tự chọn bản mới nhất. Lưu cấu hình/gán target không tự flash.

Firmware giao cho CMS một ZIP chứa đúng hai file ở gốc:

```text
firmware.zip
├── manifest.json
└── application.bin
```

Manifest gồm `releaseId`, `buildId`, `hardwareTarget`, `version` SemVer, `size`, `sha256` hex chữ thường, `publisherKeyId`, `signature`. Ký UTF-8:

```text
FIRMWARE_V1|<releaseId>|<buildId>|<hardwareTarget>|<version>|<size>|<sha256>|<publisherKeyId>
```

Image tối đa 8 MiB và không vượt slot OTA khai báo. CMS nhận một ZIP; backend xác minh/chờ duyệt/gán rồi mới gửi upgrade. ESP32 tải manifest và binary bằng token máy tại `/api/devices/:deviceId/firmware/:releaseId/manifest` và `/binary`. Binary hỗ trợ single Range, ETag và resume; vẫn phải kiểm tra hash toàn image. Public key nhà phát hành được cấp tin cậy riêng cho backend **và firmware**, không tin khóa tự khai trong manifest.

Chỉ OTA application, giữ identity/NVS; không thay bootloader/partition table. Sau self-test gửi BOOT/result đúng build. Rollback gửi `success:false,reason:"ROLLED_BACK"` cùng build thực tế. Reconnect/tải xong không được báo thành công.

Đổi khóa QR dùng `ROTATE_QR_KEY → KEY_PROPOSAL → KEY_COMMIT → KEY_ACTIVATED → KEY_CONFIRMED`. Giữ candidate/operation qua mất mạng, dừng phát QR từ activation đến confirmation. Proof ký `ROTATE_PROPOSE_V1|operationId|deviceId|generation|nonce|keyId` và `ROTATE_ACTIVATE_V1|operationId|deviceId|generation|nonce|keyId`; private key không gửi lên backend.

## Mã nguồn

Repo gồm backend/CMS, cấu hình build/deploy, `bun.lock`, `schema.sql`, script vận hành và README. AGENTS.md, `.agents`, node_modules, file secret và dữ liệu local được Git bỏ qua. Khi deploy Cloudflare, Wrangler chỉ upload Worker bundle và assets CMS đã build.

Mã/schema hiện hành để đội tích hợp đối chiếu: `src/contracts.ts`, `src/registration-contracts.ts`, `src/runtime-contracts.ts`, `src/routes/*` và endpoint `/openapi.json`. Các mốc thời gian dùng UTC epoch milliseconds; ID là ASCII `[A-Za-z0-9_-]{1,128}`; lỗi HTTP theo `{error:{code,message,requestId}}`.

ESP32 thực vẫn cần đội firmware xác nhận TLS/SNTP, Ed25519/QR màn hình, NVS/journal, quét/đổi Wi-Fi, partition, mất điện và rollback. QR ngắn hạn giảm khả năng relay nhưng không chứng minh tuyệt đối người quét đang ở bảo tàng.
