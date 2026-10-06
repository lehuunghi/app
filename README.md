# Webmail App — Android, iOS và web

Ứng dụng Webmail tiếng Việt, dùng lại giao diện React của bản [webmail](https://github.com/lehuunghi/webmail), với giao diện lấy cảm hứng từ Gmail. Android và iOS dùng Capacitor, cùng kết nối tới máy chủ Webmail/Stalwart đang dùng trên máy tính.

- Tiếng Việt mặc định; có thể đổi ngôn ngữ trước khi đăng nhập.
- Màn hình đăng nhập không hiển thị tên miền dịch vụ hoặc liên kết mã nguồn; thông tin mã nguồn nằm trong Cài đặt. Menu tài khoản gồm Cài đặt, Làm mới và Đăng xuất.
- Giao diện được đóng gói trong ứng dụng. App dùng cố định **https://jmail.vn**, mở thẳng màn hình đăng nhập và gọi API tại **https://webmail.jmail.vn** theo chuyển hướng của dịch vụ.
- Kết nối HTTP native, cookie phiên đăng nhập do nền tảng quản lý; không lưu mật khẩu trong cấu hình hoặc mã nguồn.
- Kiểm tra thay đổi JMAP mỗi 30 giây khi app ở phía trước, tạm dừng khi app ở nền và kiểm tra lại khi quay về.
- Chọn tệp đính kèm bằng bộ chọn tệp của thiết bị; tải/lưu/chia sẻ bằng bảng chia sẻ native.
- Mặc định giữ đăng nhập trên thiết bị riêng; login không có lựa chọn thiết bị riêng. Lỗi kết nối dùng thông báo ngắn tiếng Việt.
- Thông báo native, nút thử và hướng dẫn [cấu hình Firebase/APNs](docs/THONG-BAO-NATIVE.md).
- Có sẵn dự án Android và iOS, biểu tượng Webmail riêng và quy trình build bản thử nghiệm.
- Đăng xuất chặn tự khôi phục phiên cũ kể cả khi mất mạng; chỉ đăng nhập thành công mới mở lại phiên.
- Có nút thử lại khi khởi động lỗi và khoảng trống cho vùng tai thỏ, thanh trạng thái và thanh điều hướng.

**Trạng thái:** phiên bản native 1.1.0 (build 7). Android APK debug và ứng dụng iOS simulator được build bằng GitHub Actions. Cần kiểm thử trên điện thoại thật và ký bản phát hành trước khi đưa lên cửa hàng. Thông báo native đã có mã tích hợp Android/iOS và máy chủ; nhận khi app đóng cần triển khai API mới, Firebase/APNs và bản iOS ký hợp lệ. Nhận nội dung từ bảng chia sẻ của app khác và đọc thư ngoại tuyến chưa được triển khai.

Giao diện đồng bộ từ `lehuunghi/webmail` tại commit `bfd7320612cba7eba905365db6c79a40514f0369`: đăng nhập gọn, logo theo triển khai, thanh điều hướng workspace, tìm kiếm nâng cao và thư mục kiểu Gmail. Các lớp HTTP native, cookie, đăng xuất, tệp chia sẻ và safe area được giữ trong nhánh app.

## Chuẩn bị và mở dự án

Dùng Node.js 24, hoặc Node.js 22.12 trở lên.

```bash
npm ci --ignore-scripts
npm run mobile:sync
npm run mobile:check
```

Android: cài Android Studio và SDK 36, dùng JDK 21, rồi chạy `npm run mobile:android`.

iOS: trên máy Mac có Xcode 26 trở lên, chạy `npm run mobile:ios`. Dự án sử dụng Swift Package Manager và hỗ trợ iOS 15 trở lên.

Xem **[hướng dẫn Android/iOS bằng tiếng Việt](docs/APP-DI-DONG.md)** để build APK, thử trên điện thoại, ký bản phát hành và cấu hình máy chủ chung.

## Container tự động trên GHCR

Phần web/API của repository `app` được build và đẩy tự động lên
`ghcr.io/lehuunghi/app:latest` khi cập nhật `main`, hỗ trợ AMD64 và ARM64.
Xem [hướng dẫn GHCR](docs/GHCR.md) để tải image và triển khai.

## Máy chủ dùng chung

Ứng dụng không chạy Node.js hoặc Stalwart bên trong điện thoại. Máy chủ Webmail hiện có cung cấp `/api/config`, `/api/auth/*`, `/api/jmap`, `/api/blob/*` và `/api/upload/*`; API được gọi bằng kết nối native. Một máy chủ dùng chung có thể phục vụ web, Android và iOS. Không cần mở CORS cho mọi nguồn hay tắt bảo vệ CSRF của website.

Nếu muốn chạy máy chủ từ chính mã nguồn này:

```bash
cp .env.example .env
# Sửa STALWART_URL, APP_SECRET, APP_NAME và SOURCE_URL trong .env.
npm ci --ignore-scripts
npm run build
npm start
```

Dùng HTTPS phía trước máy chủ. Không đưa `.env` hoặc `APP_SECRET` vào ứng dụng mobile.

Kho `app` có đủ `server/`, `web/`, `Dockerfile` và `docker-compose.yml` để triển khai một instance web/API riêng, không cần thay đổi kho `webmail`. Tuy nhiên APK hiện có vẫn dùng địa chỉ API cố định: đổi `.env` của máy chủ không đổi được địa chỉ bên trong APK. Để build cho instance riêng, sửa `MOBILE_SERVER_URL` (dịch vụ thư) và `MOBILE_API_URL` (web/API HTTPS) trong `web/src/lib/mobile/config.ts`, rồi chạy `npm run mobile:sync` và build lại Android/iOS. Với cấu hình hiện tại, nên đặt API ở gốc tên miền.

## Kiểm tra

```bash
npm run typecheck
npm test
npm run i18n:check
npm run mobile:sync
npm run mobile:check
```

Workflow `Build mobile test apps` chạy khi cập nhật `main` hoặc chạy thủ công. Nó build và kiểm tra mở app trên Android/iOS, kiểm tra giao diện với máy chủ JMAP giả lập, rồi lưu bản thử nghiệm lên [Releases](https://github.com/lehuunghi/app/releases). APK debug không phải bản Google Play; bản iOS dành cho simulator, chưa có IPA đã ký.

## Nguồn gốc và giấy phép

Đây là bản phát triển riêng từ `lehuunghi/webmail`, dựa trên dự án gốc `Coffey-Labs/ihasmail`. Giữ [LICENSE](LICENSE) và [NOTICE](NOTICE) cùng các thông báo tác giả trong mã nguồn. Phần kế thừa được phát hành theo AGPL-3.0-or-later. Repository dành cho ứng dụng có tên `app`; không cần sửa repository `webmail` để phát triển phần native.
