# Hướng dẫn Webmail cho Android và iOS

## 1. Cách hoạt động

Giao diện React được build vào `mobile-dist` và đóng gói vào ứng dụng bằng Capacitor. App luôn dùng `https://jmail.vn` và mở thẳng màn hình đăng nhập; không có ô nhập hoặc nút đổi máy chủ. Cấu hình máy chủ đã lưu trong các bản cũ bị bỏ qua. Khi nâng cấp từ máy chủ khác, app xóa dữ liệu tài khoản cục bộ và yêu cầu đăng nhập lại.

`jmail.vn` là máy chủ thư và chuyển website sang `https://webmail.jmail.vn`. App tự gọi các API Webmail Node.js ở `https://webmail.jmail.vn`; người dùng chỉ nhập tài khoản và mật khẩu. Các API được gọi bằng HTTP native và sử dụng cookie phiên đăng nhập của máy chủ. Tài khoản và dữ liệu thư vẫn nằm trên Stalwart; đọc thư hoặc đánh dấu đã đọc trên một thiết bị sẽ được các thiết bị khác đồng bộ lại.

Máy chủ cố định dùng HTTPS với chứng chỉ hợp lệ. Không có mật khẩu mail hay `APP_SECRET` được nhúng vào ứng dụng. Không dùng `server.url` của Capacitor để tải toàn bộ website từ xa; cấu hình hiện tại dùng giao diện đã đóng gói.

## 2. Chuẩn bị máy chủ

1. Có một máy chủ Webmail đang hoạt động, dùng cùng Stalwart với bản web.
2. Có tên miền và chứng chỉ HTTPS hợp lệ, ví dụ `https://jmail.vn`.
3. Kiểm tra `https://webmail.jmail.vn/api/health` có phản hồi và `/api/config` trả JSON có `appName`.
4. Nếu dùng reverse proxy, chuyển tiếp nguyên đường dẫn tới Node.js. Nếu chạy dưới `/webmail`, build và chạy máy chủ web với cùng `BASE_PATH=/webmail`.
5. Giữ các bảo vệ CSRF và cookie của website. Ứng dụng gửi header giao thức hiện có và dùng HTTP native; không cần thêm CORS `*`.

Bản mobile đặt `BASE_PATH` của các tài nguyên đóng gói về rỗng. Dịch vụ thư mặc định là `https://jmail.vn`; API được cố định vào `https://webmail.jmail.vn`, đúng địa chỉ website do máy chủ công bố. Vì vậy, không build app mobile bằng `BASE_PATH` của máy chủ.

Chọn **Thiết bị này là của tôi** nếu muốn giữ phiên đăng nhập lâu hơn và lưu cài đặt, địa chỉ gần đây trên thiết bị. Nếu không chọn, app đăng xuất sau 5 phút không hoạt động và xóa dữ liệu tài khoản cục bộ.

Đăng xuất sẽ yêu cầu máy chủ kết thúc phiên và xóa cookie native cùng tệp chia sẻ tạm. App lưu một cờ đã đăng xuất trước khi gọi mạng, nên sẽ không tự khôi phục cookie cũ nếu mất mạng hoặc xóa cookie thất bại. Chỉ đăng nhập thành công mới gỡ cờ này. Phản hồi phiên đến chậm từ tài khoản cũ cũng bị bỏ qua. Cờ chỉ chứa trạng thái đăng xuất, không chứa mật khẩu hoặc nội dung thư. Máy chủ chỉ có thể thu hồi phiên khi nhận được yêu cầu; mất mạng không bảo đảm thu hồi phiên phía máy chủ.

Nếu bridge native khởi động lỗi, app hiển thị thông báo tiếng Việt cùng nút **Thử lại**.

## 3. Lấy mã nguồn và cài dependencies

Kho `app` chứa mã nguồn dành riêng cho ứng dụng. Lấy mã nguồn bằng:

```bash
git clone https://github.com/lehuunghi/app.git
cd app
npm ci --ignore-scripts
npm run mobile:sync
npm run mobile:check
```

Nếu dùng gói mã nguồn ZIP, giải nén rồi chạy các lệnh npm trong thư mục chứa `package.json`.

Dùng Node.js 24, hoặc 22.12 trở lên. Dependencies được khóa trong `package-lock.json`; ưu tiên `npm ci`. Các dự án `android/` và `ios/` đã có sẵn, không cần chạy `cap add` lần nữa.

Mỗi khi sửa giao diện, chạy lại:

```bash
npm run mobile:sync
```

Lệnh này build giao diện và sao chép tài nguyên cùng cấu hình/plugin vào cả hai nền tảng. Nếu chỉ làm một nền tảng:

```bash
npm run mobile:build
npx cap sync android
# Hoặc: npx cap sync ios
```

## 4. Android: chạy thử và tạo APK

### Chuẩn bị

- Android Studio Otter 2025.2.1 trở lên.
- Android SDK Platform 36 và Build Tools 36.0.0.
- JDK 21; cấu hình Gradle JDK trong Android Studio về JDK 21.
- Điện thoại Android 7.0 trở lên, hoặc emulator tương ứng. Android System WebView cần được cập nhật.

### Mở và chạy

```bash
npm run mobile:android
```

Trong Android Studio, chờ Gradle Sync xong. Chọn emulator hoặc điện thoại đã bật USB debugging, rồi nhấn Run. Trên màn hình đầu, nhập địa chỉ HTTPS của Webmail; màn hình tiếp theo dùng tài khoản thư như trên website.

### Build APK debug bằng dòng lệnh

```bash
npm run mobile:build
npx cap sync android
cd android
./gradlew assembleDebug
```

Windows dùng `gradlew.bat assembleDebug`. APK ở:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

APK debug chỉ dùng kiểm thử. Để phát hành, dùng Android Studio → Build → Generate Signed App Bundle / APK; chọn Android App Bundle cho Google Play và ký bằng keystore của bạn. Không commit keystore, mật khẩu ký hoặc `local.properties`. Tăng `versionCode` cho mỗi bản phát hành trong `android/app/build.gradle`.

Package hiện tại là `com.lehuunghi.webmail`, tên hiển thị **Webmail**. Nếu đổi package trước lần phát hành đầu tiên, sửa đồng bộ `capacitor.config.json`, `android/app/build.gradle`, package của `MainActivity.java`, đường dẫn Java và Bundle Identifier của iOS. `cap sync` không tự đổi tên các dự án native đã tạo.

## 5. iOS: simulator, iPhone và bản phát hành

### Chuẩn bị

- Máy Mac có Xcode 26 trở lên.
- iOS Deployment Target 15.0 trở lên.
- Node.js như phần trên.
- Apple ID để chạy trên thiết bị; tài khoản Apple Developer phù hợp để phát hành TestFlight/App Store.

### Mở và chạy

```bash
npm run mobile:build
npx cap sync ios
npm run mobile:ios
```

Dự án dùng Swift Package Manager. Không cần tự tạo Podfile hoặc chạy `pod install`.

Trong Xcode, mở target App, chọn Signing & Capabilities, đặt Team của bạn và kiểm tra Bundle Identifier `com.lehuunghi.webmail`. Chọn simulator rồi Run. Để chạy trên iPhone, kết nối thiết bị, chọn thiết bị đó và hoàn tất ký development theo hướng dẫn Xcode.

Build simulator bằng dòng lệnh trên Mac:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

Bản simulator không cài lên iPhone. Để tạo bản cho thiết bị/TestFlight, chọn Any iOS Device trong Xcode, Product → Archive, rồi Distribute App theo tài khoản và cấu hình ký của bạn. Chưa có IPA đã ký trong repository.

Đã thêm `PrivacyInfo.xcprivacy` cho API timestamp mà plugin Filesystem sử dụng. Khi bổ sung plugin hoặc tính năng khác, rà soát lại khai báo quyền và privacy manifest theo API thực tế.

## 6. Build thử bằng GitHub Actions

Khi mã nguồn đã nằm trong kho `app`, mở Actions → **Build mobile test apps** → Run workflow.

- Job Android tạo `webmail-android-debug` chứa APK debug.
- Job iOS tạo `webmail-ios-simulator` chứa ứng dụng dành cho simulator, không phải IPA cho iPhone.
- Các job không chứa khóa ký và không tự phát hành lên cửa hàng.
- Runner iOS phải có Xcode 26 trở lên. Nếu runner mặc định chưa có phiên bản cần thiết, đổi runner hoặc chọn Xcode phù hợp trước khi build.

Workflow này có sẵn để chạy thủ công. Chỉ xem artifact có thực sự xuất hiện sau khi workflow thành công là bằng chứng build native hoàn tất.

## 7. Những phần đã có và giới hạn hiện tại

| Phần | Trạng thái |
| --- | --- |
| Giao diện React dùng chung, tiếng Việt mặc định | Đã chuẩn bị và build |
| Dự án Android/iOS, icon riêng, plugin native | Đã tạo và đồng bộ |
| Kết nối API bằng HTTP native | Đã tích hợp; cần thử với máy chủ thật trên thiết bị |
| Đồng bộ JMAP khi app mở | Mỗi 30 giây; dừng khi ở nền, kiểm tra lại khi quay về |
| Chọn tệp đính kèm | Dùng bộ chọn tệp của WebView/thiết bị |
| Lưu và chia sẻ tệp | Dùng Filesystem cache và Share native |
| Đóng bảng chia sẻ | Không báo lỗi tải tệp; xóa bản tạm của lần chia sẻ bị hủy |
| Đăng xuất khi mất mạng | Chặn khôi phục phiên cũ trên app; vẫn cần mạng để thu hồi phiên phía máy chủ |
| Khởi động lỗi | Màn hình thông báo và nút thử lại bằng tiếng Việt |
| Vùng tai thỏ/thanh điều hướng | CSS safe area cho thanh trên, hộp thoại và khung soạn thư |
| Xem ảnh đính kèm, ảnh CID và ảnh qua privacy proxy | Đã thêm tải qua HTTP native |
| PDF | Mở/lưu qua bảng chia sẻ native |
| Thông báo khi app đã đóng | Chưa có FCM/APNs và backend đăng ký thiết bị |
| Nhận nội dung từ Share sheet của app khác | Chưa tích hợp intent/share extension native |
| Đọc thư ngoại tuyến | Chưa có kho thư offline |
| APK/IPA đã ký, phát hành cửa hàng | Chưa thực hiện |

Web Push hiện có dành cho website/PWA; không được coi là push native cho Android/iOS. Muốn thông báo khi app đóng cần backend đăng ký thiết bị, xử lý sự kiện thư và gửi FCM/APNs, rồi xử lý hủy đăng ký khi đăng xuất.

Email HTML vẫn đi qua bộ lọc nội dung. App chỉ tải ảnh đã được cho phép; dữ liệu ảnh của API được chuyển thành URL blob trong WebView để không phụ thuộc cookie của thẻ `<img>`. Tệp chia sẻ nằm trong cache tạm, được xóa khi app khởi động lại hoặc đăng xuất. Tệp lớn vẫn có thể tốn bộ nhớ qua cầu nối JS/native; cần thử giới hạn upload thực tế trước phát hành.

## 8. Kiểm thử trên điện thoại trước phát hành

1. App mở thẳng màn hình đăng nhập, không có ô nhập/nút đổi máy chủ; dịch vụ mặc định là `https://jmail.vn`, API dùng `https://webmail.jmail.vn`.
2. Đăng nhập đúng/sai, đăng xuất, mở lại app và nâng cấp từ bản cũ đã lưu máy chủ khác. Thử đăng xuất khi mất mạng rồi đóng/mở app: app phải yêu cầu đăng nhập lại dù cookie cũ còn trên thiết bị.
3. Đọc/gửi thư trên tài khoản thử nghiệm; kiểm tra trạng thái đã đọc trên web và điện thoại.
4. Tải ảnh CID và ảnh bên ngoài theo chính sách cho phép; thử tắt tải ảnh.
5. Chọn/tải/chia sẻ ảnh, PDF và tệp văn bản; thử tệp có tên tiếng Việt và tệp gần giới hạn upload. Đóng bảng chia sẻ mà không chọn nơi lưu: không được hiện thông báo tải thất bại.
6. Đưa app về nền rồi mở lại; kiểm tra thư mới và mất kết nối mạng.
7. Trên Android, thử nút Back khi đang soạn thư chưa lưu.
8. Kiểm tra bàn phím, tai thỏ, xoay màn hình và màn hình nhỏ trên cả hai nền tảng.
9. Trước khi gửi cửa hàng, hoàn tất signing, mô tả quyền riêng tư, thông tin hỗ trợ và kiểm thử tài khoản dùng cho review.

Bộ kiểm thử tự động không thay thế bước thử trên Android/iPhone. GitHub Actions biên dịch APK debug và bản iOS simulator; môi trường sửa mã nguồn không có Android SDK hoạt động hoặc Xcode. Bản thử nghiệm hiện tại là 1.0.2 (build 3).

## 9. Nguồn tham khảo

- [Capacitor HTTP](https://capacitorjs.com/docs/apis/http)
- [Capacitor 8 và yêu cầu nền tảng](https://capacitorjs.com/docs/updating/8-0)
- [Quy trình phát triển Capacitor](https://capacitorjs.com/docs/basics/workflow)
- [Filesystem và privacy manifest](https://capacitorjs.com/docs/apis/filesystem)
- [Quy định App Review của Apple](https://developer.apple.com/app-store/review/guidelines/)
