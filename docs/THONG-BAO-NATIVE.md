# Thông báo Android và iOS — 1.1.0 (build 7)

App có thông báo native và nút **Cài đặt → Thông báo → Thử thông báo**. Quyền thông báo được hỏi sau khi đăng nhập, không nằm trên login. Có thể tắt thông báo cho thiết bị trong Cài đặt. Nút thử chỉ kiểm tra thông báo cục bộ, không chứng minh Firebase/APNs hoặc máy chủ đã hoạt động.

Máy chủ trong kho `app` kiểm tra `Email/changes` mỗi 30 giây và gửi thông báo cho thư mới chưa đọc trong Inbox. Chạy trên máy chủ nên không phụ thuộc timer của app khi iOS/Android dừng ứng dụng. Khi đăng ký, máy chủ lấy trạng thái hiện tại làm mốc: không báo lại toàn bộ thư cũ. Thay đổi đã đọc, đánh dấu hoặc chuyển thư mục không tạo thông báo thư mới. Nếu không còn lấy được changes, máy chủ lấy mốc mới để tránh báo hàng loạt thư lịch sử.

Thông báo chỉ có “Webmail / Bạn có email mới.”; không gửi người gửi, tiêu đề, nội dung hoặc mật khẩu tới Firebase/APNs. Nhấn thông báo mở Inbox của phiên hiện tại; thông báo của phiên/tài khoản cũ bị bỏ qua. Nhiều thư trong cùng lần kiểm tra được gộp thành một thông báo. Hệ điều hành và nhà cung cấp có thể trì hoãn hoặc bỏ thông báo; đây không phải cam kết nhận tức thời. Khi thiếu cấu hình nền, app vẫn có thể báo thư mới khi đang mở và đồng bộ được.

## Máy chủ API

Triển khai phiên bản `server/` mới ở **https://webmail.jmail.vn**, dùng cùng Stalwart hiện tại. Chỉ cài APK không cập nhật máy chủ. Không cần sửa kho `lehuunghi/webmail`; có thể triển khai API từ kho `lehuunghi/app` như hướng dẫn [APP-DI-DONG.md](APP-DI-DONG.md).

Giữ `APP_SECRET` cố định và `SESSION_FILE` trên volume bền vững. Đặt `NATIVE_PUSH_FILE=/data/native-push.json` trên cùng volume. Nếu bỏ biến này, mặc định là `${SESSION_FILE}.native-push`. Khi không có file bền vững hoặc không có cấu hình nhà cung cấp, API báo chưa sẵn sàng. Không chạy nhiều tiến trình/replica cùng ghi file này; cần database và hàng đợi dùng chung trước khi mở rộng. Số thiết bị giới hạn 20 mỗi tài khoản, tối đa 4 lần kiểm tra/gửi cùng lúc.

Thông báo nền cần quyền truy cập mail khi không có cookie của app. Đăng ký thiết bị vì thế lưu thông tin xác thực upstream và token thiết bị dưới dạng AES-256-GCM, với khóa riêng suy ra từ `APP_SECRET` và salt. Khác với file phiên thông thường, người có cả `APP_SECRET` và file native có thể giải mã quyền truy cập nền. Bảo vệ và sao lưu chúng như thông tin xác thực mail; không đưa vào repo, APK, log hoặc image Docker. File được tạo với quyền 0600. Chỉ phiên đăng nhập tin cậy, còn hiệu lực mới đăng ký được.

Mỗi lần kiểm tra/gửi đều kiểm tra phiên chưa bị thu hồi/hết hạn và không tự gia hạn phiên. Đăng xuất trực tuyến hủy đăng ký và phiên. Khi mất mạng, app chặn khôi phục phiên cũ, hủy đăng ký native và xóa thông báo trên thiết bị; máy chủ chỉ thu hồi khi nhận được yêu cầu. Thông báo đã gửi tới nhà cung cấp có thể còn đến trong tối đa TTL 5 phút. Nội dung luôn được giữ chung chung.

## Android — Firebase

1. Tạo ứng dụng Android trong Firebase với package **com.lehuunghi.webmail** và bật FCM HTTP v1.
2. Đặt cấu hình client thật vào `android/app/google-services.json` trước `npm run mobile:sync`. Build kiểm tra package khớp. Không dùng JSON mẫu hoặc service-account JSON thay cho client JSON.
3. Trên GitHub Actions, thêm repository secret **GOOGLE_SERVICES_JSON** chứa client JSON. Workflow Android tạo file trước build. Tăng `versionCode` khi build lại để xuất link tải mới.
4. Trên máy chủ, mount service-account JSON và đặt `FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase-service-account.json`. Service account phải có quyền gửi FCM trong đúng project. Khóa này chỉ đặt trên máy chủ, không đặt trong APK hoặc biến build client.
5. Cài APK mới, đăng nhập và cho phép thông báo. Build thiếu client JSON chủ động bỏ qua FCM register/unregister để không làm app crash; cần build lại sau khi bổ sung cấu hình.

## iOS — APNs

1. Trong Apple Developer, bật Push Notifications cho App ID **com.lehuunghi.webmail**, tạo provisioning profile hỗ trợ push và ký app bằng đúng Team.
2. Dự án đã có `App.entitlements` và callbacks AppDelegate. Debug dùng `aps-environment=development`, Release dùng `production`.
3. Mount khóa `.p8` trên máy chủ, cấu hình `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC=com.lehuunghi.webmail`.
4. Đặt `APNS_SANDBOX=1` để thử bản Debug trên iPhone; `APNS_SANDBOX=0` cho TestFlight/App Store. Mỗi API instance dùng một môi trường APNs; thử Debug bằng instance thử riêng, không trộn token sandbox và production.
5. Build bản ký qua Xcode/TestFlight rồi thử trên iPhone thật. ZIP simulator được xuất bởi CI không phải IPA cài trên iPhone và không chứng minh APNs thực tế.

## Kiểm tra sau triển khai

- Đăng nhập và cho phép thông báo; Cài đặt phải ghi có thể nhận khi đóng ứng dụng. Nếu chưa kết nối, kiểm tra cấu hình client, nhà cung cấp và API máy chủ.
- Bấm thử thông báo để xác nhận quyền và kênh thông báo trên điện thoại.
- Đóng app/đưa về nền, gửi một email mới vào Inbox: thông báo thường đến sau một chu kỳ kiểm tra cộng độ trễ nhà cung cấp. Nhấn để mở hộp thư.
- Đánh dấu thư đã đọc/chuyển thư cũ: không phát thông báo mới. Khởi động lại API: cursor và lần gửi chưa thành công còn được phục hồi.
- Đăng xuất, thu hồi phiên hoặc đổi tài khoản: không tiếp tục gửi cho phiên cũ. Thử từ chối quyền và tắt thông báo trong app.
- Khi có lỗi tạm thời, lần gửi được giữ để thử lại; token không còn hợp lệ bị xóa. Sau sự cố đúng thời điểm gửi, một thông báo có thể được gửi lại; Android tag/APNs collapse ID gộp thông báo cùng nhóm.

## Email cũ

Có thể đọc và tìm lại email cũ khi còn trên máy chủ và đang có kết nối. Danh sách tải thêm theo từng trang bằng `Email/query`; việc nâng cấp/cài app không tạo hộp thư trống riêng. App chưa có kho lưu nội dung thư để đọc sau khi đóng app rồi mở lại trong chế độ mất mạng. Thư đã bị xóa vĩnh viễn cần phục hồi từ máy chủ hoặc bản sao lưu.

## Nguồn chính thức

- [Capacitor Push Notifications](https://capacitorjs.com/docs/apis/push-notifications)
- [Capacitor Local Notifications](https://capacitorjs.com/docs/apis/local-notifications)
- [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
- [Google service account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)
- [APNs token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [JMAP Mail, RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html)
