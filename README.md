# VNFAM — quản trị thiết bị ESP32

Hệ thống quản lý các máy phát QR tại đầu vào bảo tàng. ESP32 tự tạo khóa, đổi QR mỗi 30 giây; backend xác minh QR để backend minigame xác nhận lượt check-in. CMS dành cho người quản trị thiết bị, không có giao diện người chơi hoặc cơ chế trao thưởng.

## Hệ thống có gì

- **Thiết bị:** ESP32 gửi public key và chứng minh sở hữu private key; backend lưu D1, tự tạo thiết bị và thiết bị xuất hiện thẳng trong danh sách **Thiết bị**. CMS chỉ xem kết nối, bật/tắt tiếp nhận check-in, cấu hình và lịch sử; không có màn hình đăng ký riêng. Xóa máy sẽ thu hồi quyền kết nối/khóa QR, ẩn khỏi danh sách đang dùng; lịch sử được giữ lại.
- **Bảo trì:** quét/chọn Wi-Fi nếu firmware hỗ trợ, lưu/áp dụng cấu hình, lấy trạng thái, khởi động lại, xóa Wi-Fi, đổi khóa QR và flash firmware cho một máy.
- **Cài đặt chung:** SNTP/múi giờ, chính sách xác minh QR và tải firmware để cập nhật các máy được chọn.
- **Check-in và Nhật ký:** xem lượt đã xác nhận, tên tương ứng với Subject / Scope, tên máy và hành động quản trị. ID phục vụ tra cứu nằm trong phần thu gọn.

Backend dùng TypeScript, Hono, Cloudflare Workers; D1 lưu dữ liệu, mỗi máy có một Durable Object quản lý kết nối/lệnh, R2 private chứa firmware. CMS dùng React/Vite và một Hono bridge gọi backend qua Service Binding. Service token chỉ nằm ở server.

Tên thiết bị cũng là vị trí hiển thị cho người vận hành, ví dụ “Sảnh A, tầng 1”; không lưu thêm một trường vị trí riêng. Public key thiết bị chỉ dùng trong backend để kiểm tra chữ ký, không trả qua API tổng quan CMS.

Bun quản lý dependency và chạy lệnh; Node chạy bên trong Wrangler và một số công cụ. Worker production chạy bằng workerd. Dự án không chứa mã firmware ESP32 hoặc hệ thống đăng nhập riêng; khi ghép vào CMS tổng, nối nguồn actor của bridge với người dùng đã được CMS xác thực.

## Cài và chạy local

Cần Bun từ 1.4.4 và Node 24 LTS.

`bun install` tự sinh `worker-configuration.d.ts` qua Wrangler. Đây là types cần cho TypeScript/editor, không dọn cùng bundle build; khi sửa bindings hoặc bỏ qua lifecycle scripts, chạy `bun run types`. Worker dùng `tsconfig.json`, công cụ dùng `scripts/tsconfig.json`, CMS và bridge dùng `tsconfig.cms.json`.

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

`schema.sql` là file SQL khởi tạo duy nhất, gồm hạn chấp nhận QR 60 giây và lệch tương lai tối đa 5 giây. Với database **dev đã có**, chỉ cập nhật policy chung (ảnh hưởng cả GET mới và POST cũ):

```sh
bun run db:execute --local --command "UPDATE qr_policy SET maxAgeMs=60000,futureSkewMs=5000 WHERE id=1"
```

Lệnh chỉ cập nhật policy, không đổi ID/credential/lịch sử. Không tự áp dụng lên staging hoặc production.

```sh
bun run typecheck
bun run typecheck:cms
bun run build
bun run build:cms
bun run check:registrations
```

Hai lệnh build chỉ kiểm tra/đóng gói local, không triển khai cloud. `check:registrations` build và kiểm luồng tự đăng ký trên Workers runtime với D1 tạm: nonce/proof, hoàn tất một lần, gửi trùng/đồng thời, hết hạn, khóa do proof sai và quyền xem trên CMS.

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

### 1. Đăng ký và tự xác nhận

ESP32 tự sinh cặp **ECDSA P-256**, giữ private key trên máy. Public key là điểm uncompressed `04 || X[32] || Y[32]`, tổng 65 byte; mã hóa Base64URL canonical không padding thành 87 ký tự. Proof dùng ECDSA/SHA-256, chữ ký raw IEEE P1363 `r[32] || s[32]` big-endian, tổng 64 byte, Base64URL không padding thành 86 ký tự. Backend cũng nhận khóa/proof Pure Ed25519.

`keyId = Base64URL(SHA-256(rawPublicKey))`, luôn 43 ký tự. Đây là ID khóa của backend này; không dùng `kid` hex SHA-256 của SPKI DER trong heartbeat ở repo firmware thay thế. Firmware phải chuyển chữ ký DER nội bộ sang raw cho cả proof đăng ký, khôi phục ghép nối và rotation. Private key không gửi lên server.

| Bước                   | Request                                                                                              | Kết quả                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tạo yêu cầu            | `POST /api/device-registrations` với `{publicKey,hardwareTarget,serial?}`                       | `{registrationId,nonce,expiresAt}`; lưu kín nonce trước khi tiếp tục       |
| Hoàn tất đăng ký       | `POST /api/device-registrations/:registrationId/complete` với `{nonce,proof}`                   | `201 {deviceId,generation:1,keyId,token}` đúng một lần, không chờ CMS       |

Ký chính xác UTF-8, không BOM/newline:

```text
REGISTER_V1|<registrationId>|<nonce>|<keyId>
```

Theo quyết định ngày 05/11/2026, public key được lưu ngay khi tạo challenge trong `device_registrations`. Sau proof hợp lệ tại `complete`, một transaction D1 tự tạo máy, cấp credential, lưu khóa `ACTIVE` vào `qr_keys` và chuyển đăng ký sang `COMPLETED`. Tên ban đầu là serial đã bỏ khoảng trắng đầu/cuối, hoặc `hardwareTarget` nếu serial trống. Nonce là bí mật của challenge, phải gửi lại tại `complete`; backend không cho người chỉ biết registrationId làm tăng số lần sai proof. `confirmedAt` và trạng thái kết nối vẫn chờ `BOOT_REPORT` hợp lệ.

CMS không có màn hình đăng ký riêng. Khi proof hợp lệ, backend tự tạo thiết bị và thiết bị xuất hiện trong danh sách **Thiết bị**; CMS chỉ hiển thị trạng thái vận hành và công cụ khôi phục ghép nối. Nonce/token không hiện trong CMS. Phiên hết hạn sau 10 phút; state chỉ có `CHALLENGE`, `COMPLETED`, `LOCKED`, `EXPIRED`. Gửi đúng nonce nhưng sai proof đủ 5 lần bị khóa. Challenge chỉ hoàn tất một lần; gọi lại không tạo thêm máy hoặc trả lại token.

Đăng ký mới là luồng công khai: proof chỉ chứng minh bên gọi sở hữu private key, không chứng minh thiết bị thuộc tổ chức. Thiết bị gọi được endpoint và vượt qua kiểm tra hiện có sẽ được tự đăng ký vào site/scope do backend cấu hình. Luồng này không cho phép lấy khóa mới tự khai để thay identity của máy đã có; recovery và rotation vẫn phải xác thực.

Lưu bền token/deviceId/generation trước khi kết nối. Mất response sau `complete` không được tự xin token khác; admin dùng **Khôi phục ghép nối** trên hồ sơ thiết bị đã tạo. Thiết bị có thể giữ nguyên khóa QR và ký proof cho phiên pairing mới; recovery tăng generation, cấp token mới và vô hiệu token cũ. Khóa đã thuộc máy khác không được chuyển sang máy này. Mất mạng đơn thuần dùng lại identity, không đăng ký máy mới. Schema đầy đủ: `src/registration-contracts.ts`; pairing phục hồi: `/api/device-pairings/complete` trong OpenAPI.

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

#### QR theo contract: GET chỉ xác minh

Firmware ký **ECDSA P-256 với SHA-256** trên đúng ASCII sau, không BOM/khoảng trắng/newline:

```text
t = floor(unixSeconds / 30) * 30
v1.<did>.<t>
```

`did` là deviceId `[a-z0-9-]{1,32}`. Public key uncompressed 65 byte, bắt đầu bằng `04`; chữ ký raw `r || s` 64 byte, mã hóa Base64URL canonical không padding. QR dùng chữ ký raw, không nhận ASN.1 DER. QR chứa URL:

```text
https://<api-host>/checkin?v=1&did=<deviceId>&t=<unixSeconds>&sig=<base64url>
```

WebCrypto import public key với `format: "raw"`, `{name: "ECDSA", namedCurve: "P-256"}` rồi verify bằng `{name: "ECDSA", hash: "SHA-256"}` trên message gốc. WebCrypto tự hash một lần; không SHA-256 message trước khi gọi verify. Endpoint chỉ nhận đúng bốn tham số trên, mỗi tham số một giá trị.

Firmware dùng deviceId đã nhận khi ghép nối. Máy đăng ký mới được cấp ID hex thường 32 ký tự; máy dev cũ dùng UUID 36 ký tự cần đăng ký mới để thử giao thức này. ID/credential/lịch sử cũ không bị tự sửa hoặc xóa. Khi mất mạng hoặc reboot, dùng lại identity đã lưu, không tự đăng ký lại.

Đặt `qrBaseUrl` thành `https://<api-host>/checkin` qua API cấu hình hiện có, rồi gửi `APPLY_CONFIG`; firmware cần hỗ trợ đọc/áp dụng cấu hình này và triển khai format trên. Không tự thay cấu hình máy hay đoán format từ URL. Khi thử `dev:cms`, `/checkin` cũng được chuyển tới backend trên cùng host cổng 8788; HTTP local dùng để dev, cấu hình URL thiết bị vẫn yêu cầu HTTPS. Dùng host HTTPS trỏ tới môi trường dev hoặc gọi URL local trực tiếp từ công cụ kiểm thử.

Repo [firmware tại commit bf8039b](https://github.com/dongduy1412/vnfarm_qrcode/tree/bf8039bd8272f88105f2277176073557f4af9bbc) đã ký đúng định dạng QR này nhưng đang lấy `did` từ MAC, cố định URL theo build và gửi HTTP heartbeat `/api/devices/:did/ping`. Chưa có client đăng ký/complete và WebSocket của backend này. Đội firmware cần nối các bước ở mục 1–2, lưu và dùng deviceId server cấp, áp dụng đúng URL môi trường và giữ chu kỳ 30 giây. Backend không tự tin khóa từ MAC, không có endpoint nhập public key thủ công.

`GET /checkin` không cần Bearer token, không lưu người chơi/check-in và không redirect. Hợp lệ trả `200`:

```json
{
    "valid": true,
    "deviceId": "door-1",
    "issuedAtMs": 1800000000000,
    "verifiedAtMs": 1800000005000
}
```

`t` trên URL dùng **giây**; hai field có hậu tố `Ms` trong kết quả dùng **milliseconds**. Thiếu/trùng/dư/sai tham số hoặc tương lai quá xa trả `400 {"error":"bad_request"}`; máy không tồn tại trả `404 unknown_device`; chữ ký sai hoặc máy/khóa không đủ điều kiện trả `401 invalid_signature`; quá hạn trả `410 expired`; giới hạn tần suất trả `429 rate_limited`; storage/policy không khả dụng trả `503 unavailable`. Tất cả lỗi có shape `{"error":"<code>"}`. Các phản hồi đều `Cache-Control: no-store`, kể cả khi browser không gửi `Accept: application/json`. Không hiển thị trang lỗi HTML ở module dev này.

GET mới và POST cũ dùng chung policy quản trị: mặc định TTL 60 giây, future skew 5 giây; khoảng cấu hình vẫn là TTL 30–60 giây và skew 0–5 giây. Đổi QR mỗi 30 giây không phải thời hạn phiên người chơi. Giới hạn dev là 120 request/phút/IP (`CF-Connecting-IP`); khi chạy local thiếu header dùng một bucket chung.

Module `src/checkin-verification.ts` export `ContractQrQuery`, `contractQrBytes` và `verifyCheckinQr(qr, publicKey, policy, nowMs)`. Backend tổng có thể tái sử dụng bằng cách validate đầu vào, cung cấp khóa tin cậy/policy/giờ server rồi nhận kết quả hoặc mã lỗi; phần crypto không phụ thuộc Hono/D1/DO. Phiên đăng nhập, ghi nhận người chơi, hiệu lực check-in, chống ghi trùng theo user, status và redirect/tem do backend tổng nối sau. JSON xác minh không phải credential hoặc bằng chứng cấp thưởng dùng lại được.

#### QR/API hiện có: giữ tương thích

Đọc `GET /api/devices/:deviceId/desired-state` để lấy `config:{scopeId,qrBaseUrl}`, firmware target và operation đang đối chiếu. Đổi QR mỗi 30 giây:

```text
issuedAtMs = floor(nowMs / 30000) * 30000
CHECKIN_V1|<deviceId>|<scopeId>|<keyId>|<issuedAtMs>
```

Ký dòng trên bằng loại khóa thiết bị đã đăng ký: Ed25519 hoặc ECDSA P-256/SHA-256 với chữ ký raw P1363. POST cũ tiếp tục tạo receipt sau khi thiết bị đổi sang khóa P-256; message vẫn là `CHECKIN_V1|...`, không dùng chữ ký `v1.<did>.<t>` của GET thay thế. QR chứa `{version:1,deviceId,scopeId,keyId,issuedAtMs,signature}`. `qrBaseUrl` hiện rỗng: phát JSON đã ký, chưa redirect. Khi tích hợp có URL HTTPS, dùng URL đó với các trường QR làm query parameters. Backend nhận các trường đã tách, không fetch URL.

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

Thay timestamp/chữ ký bằng dữ liệu hiện tại. Cửa sổ mặc định trên database mới hoặc đã áp dụng SQL policy: QR không cũ quá 60 giây, không vượt tương lai quá 5 giây. Nhiều subject dùng chung QR được. Kết quả trả bản xác nhận với `checkInId` và thời điểm, không trả quyền chơi/nhận thưởng. `subjectName` là tên CMS hiển thị trong **Subject / Scope**; thiếu tên thì hiện chưa có tên. Scope có tên từ cấu hình server.

### 4. Cấu hình, lệnh và OTA

Server gửi `COMMAND` với `{operationId,payload:{action,deadline,parameters}}`. Firmware lưu journal trước side effect, gửi `COMMAND_ACK`, thực hiện rồi gửi `COMMAND_RESULT`; progress thực có thể gửi `COMMAND_PROGRESS`. HTTP 202/ACK/100% progress không phải hoàn tất.

| Action             | Bằng chứng kết quả                                                          |
| ------------------ | --------------------------------------------------------------------------- |
| `REQUEST_STATUS`   | `DEVICE_STATUS` mới cùng operationId                                        |
| `APPLY_CONFIG`     | Result thành công đúng operationId; có Wi-Fi thì runtimeConfigVersion/wifiSsid phải khớp |
| `REBOOT`           | BOOT có bootId mới, sau đó result đối chiếu                                 |
| `RESET_WIFI`       | Result có `wifiCleared:true`; mất socket không đủ                           |
| `SCAN_WIFI`        | Result chứa scannedAtMs và wifiNetworks thực đo                             |
| `UPGRADE_FIRMWARE` | BOOT build đích/healthy và result cùng bootId/buildId/healthy               |

`UNKNOWN` nghĩa là chưa xác định kết quả, vẫn chặn lệnh xung đột. Khi reconnect, đọc `activeOperation` trong desired state và đối chiếu journal. Chỉ báo `NOT_EXECUTED` khi lưu bền chứng minh chưa chạy; không tự thực thi lại thao tác chưa rõ.

Wi-Fi được CMS lưu và áp dụng riêng. Máy khai `runtimeConfigVersion:1`; `APPLY_CONFIG` không mang password. Tải `GET /api/devices/:deviceId/network-config?operationId=...` bằng token máy để nhận `{ssid,password}` đúng operation. Khi có lệnh `APPLY_CONFIG` đang chạy hoặc chưa rõ kết quả (`UNKNOWN`), không được sửa cấu hình cho đến khi lệnh được đối chiếu xong. Giữ mạng cũ để khôi phục, chỉ báo thành công sau khi nối lại backend bằng mạng mới. Khai `SCAN_WIFI` khi có thể quét SSID/RSSI/bảo mật; kết quả theo `WifiScan` trong `src/contracts.ts`.

Theo điều chỉnh ngày 05/11/2026, cấu hình từng máy không còn số phiên bản đã lưu/đã áp dụng trong DB, HTTP hoặc bản tin WebSocket. Firmware nhận và xác nhận cấu hình theo `operationId`, không gửi các trường phiên bản cấu hình máy. Cài đặt SNTP dùng chung vẫn có `revision` để chống ghi đè nhầm.

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

Manifest vẫn dùng Pure Ed25519 với public key raw 32 byte và chữ ký raw 64 byte; thay đổi P-256 cho khóa thiết bị không đổi thuật toán ký manifest. Image tối đa 8 MiB và không vượt slot OTA khai báo. CMS nhận một ZIP; backend xác minh/chờ duyệt/gán rồi mới gửi upgrade. ESP32 tải manifest và binary bằng token máy tại `/api/devices/:deviceId/firmware/:releaseId/manifest` và `/binary`. Binary hỗ trợ single Range, ETag và resume; vẫn phải kiểm tra hash toàn image. Public key nhà phát hành được cấp tin cậy riêng cho backend **và firmware**, không tin khóa tự khai trong manifest.

Chỉ OTA application, giữ identity/NVS; không thay bootloader/partition table. Sau self-test gửi BOOT/result đúng build. Rollback gửi `success:false,reason:"ROLLED_BACK"` cùng build thực tế. Reconnect/tải xong không được báo thành công.

Đổi khóa QR dùng `ROTATE_QR_KEY → KEY_PROPOSAL → KEY_COMMIT → KEY_ACTIVATED → KEY_CONFIRMED`. Giữ candidate/operation qua mất mạng, dừng phát QR từ activation đến confirmation. Proof ký `ROTATE_PROPOSE_V1|operationId|deviceId|generation|nonce|keyId` và `ROTATE_ACTIVATE_V1|operationId|deviceId|generation|nonce|keyId`; private key không gửi lên backend.

## Mã nguồn

Repo gồm backend/CMS, cấu hình build/deploy, `bun.lock`, `schema.sql`, script vận hành và README. AGENTS.md, `.agents`, node_modules, file secret và dữ liệu local được Git bỏ qua. Khi deploy Cloudflare, Wrangler chỉ upload Worker bundle và assets CMS đã build.

Mã/schema hiện hành để đội tích hợp đối chiếu: `src/contracts.ts`, `src/registration-contracts.ts`, `src/runtime-contracts.ts`, `src/routes/*` và endpoint `/openapi.json`. API hiện có dùng UTC epoch milliseconds, ID ASCII `[A-Za-z0-9_-]{1,128}` và lỗi `{error:{code,message,requestId}}`; `GET /checkin` có query timestamp giây, ID và lỗi riêng theo contract ở trên.

ESP32 thực vẫn cần đội firmware xác nhận TLS/SNTP, P-256/QR màn hình, ghép nối tự động, NVS/journal, quét/đổi Wi-Fi, partition, mất điện và rollback. Kiểm thử workerd/vector không thay cho xác nhận bằng QR từ board thật. QR ngắn hạn giảm khả năng relay nhưng không chứng minh tuyệt đối người quét đang ở bảo tàng.
