# Webmail App — Android, iOS và web

Ứng dụng Webmail tiếng Việt, dùng lại giao diện React của bản [webmail](https://github.com/lehuunghi/webmail), với giao diện lấy cảm hứng từ Gmail. Android và iOS dùng Capacitor, cùng kết nối tới máy chủ Webmail/Stalwart đang dùng trên máy tính.

- Tiếng Việt mặc định; có thể đổi ngôn ngữ trước khi đăng nhập.
- Giao diện được đóng gói trong ứng dụng; lần đầu mở, nhập địa chỉ **HTTPS của website Webmail**, không nhập địa chỉ JMAP/Stalwart trực tiếp.
- Kết nối HTTP native, cookie phiên đăng nhập do nền tảng quản lý; không lưu mật khẩu trong cấu hình hoặc mã nguồn.
- Kiểm tra thay đổi JMAP mỗi 30 giây khi app ở phía trước, tạm dừng khi app ở nền và kiểm tra lại khi quay về.
- Chọn tệp đính kèm bằng bộ chọn tệp của thiết bị; tải/lưu/chia sẻ bằng bảng chia sẻ native.
- Có sẵn dự án Android và iOS, biểu tượng Webmail riêng và quy trình build bản thử nghiệm.
- Đăng xuất chặn tự khôi phục phiên cũ kể cả khi mất mạng; chỉ đăng nhập thành công mới mở lại phiên.
- Có nút thử lại khi khởi động lỗi và khoảng trống cho vùng tai thỏ, thanh trạng thái và thanh điều hướng.

**Trạng thái:** phiên bản native 1.0.1 (build 2). Android APK debug và ứng dụng iOS simulator được build bằng GitHub Actions. Cần kiểm thử trên điện thoại thật và ký bản phát hành trước khi đưa lên cửa hàng. Push khi app đóng, nhận nội dung từ bảng chia sẻ của app khác và đọc thư ngoại tuyến chưa được triển khai.

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

## Kiểm tra

```bash
npm run typecheck
npm test
npm run i18n:check
npm run mobile:sync
npm run mobile:check
```

Workflow `Build mobile test apps` chạy thủ công trong GitHub Actions để tạo APK debug và ứng dụng iOS cho simulator. Nó không phát hành lên Google Play/App Store và không tạo IPA đã ký.

## Nguồn gốc và giấy phép

Đây là bản phát triển riêng từ `lehuunghi/webmail`, dựa trên dự án gốc `Coffey-Labs/ihasmail`. Giữ [LICENSE](LICENSE) và [NOTICE](NOTICE) cùng các thông báo tác giả trong mã nguồn. Phần kế thừa được phát hành theo AGPL-3.0-or-later. Repository dành cho ứng dụng có tên `app`; không cần sửa repository `webmail` để phát triển phần native.
