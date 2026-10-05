# Đăng nhập webmail bằng QR — 1.3.0 (build 9)

Trên webmail chưa đăng nhập, chọn **Đăng nhập bằng QR**. Trong app điện thoại đã đăng nhập, mở menu tài khoản → **Quét QR đăng nhập webmail** → **Quét mã QR**. Kiểm tra trình duyệt và mã đối chiếu, chọn **Cho phép đăng nhập**. Webmail tự mở hộp thư của tài khoản điện thoại, không cần nhập email/mật khẩu trên máy tính.

QR chứa một challenge ngẫu nhiên, không chứa mật khẩu, cookie hoặc phiên đăng nhập. Có hiệu lực 120 giây. Chỉ trình duyệt giữ cookie HttpOnly riêng mới nhận được phiên. Điện thoại phải chủ động xác nhận; quét không tự cấp quyền. Không duyệt QR do người khác gửi. Thông tin trình duyệt/IP chỉ để đối chiếu, không phải chứng thực danh tính.

Máy chủ cấp phiên mới riêng cho webmail, kiểm tra lại phiên điện thoại và kết nối JMAP trước khi cấp. Thử lại sau mất phản hồi trả cùng một phiên cho cùng trình duyệt trong thời hạn QR, không tạo nhiều phiên. Hủy QR hoặc đăng xuất điện thoại trước khi cấp sẽ chặn đăng nhập. Phiên webmail đã cấp độc lập; có thể thu hồi trong quản lý phiên.

## Triển khai

Cập nhật webmail frontend, Webmail API và APK cùng phiên bản. App 1.2.0 chưa có mục quét. App cố định API `https://webmail.jmail.vn`; QR chỉ chấp nhận đúng `/api/auth/qr` trên API này, không gọi địa chỉ tùy ý trong QR. Webmail phải được phục vụ trên cùng origin đó (hoặc đổi cấu hình và build app lại cho dịch vụ khác). Cần HTTPS hợp lệ và mạng trên cả hai thiết bị. Không cần Firebase/APNs để đăng nhập bằng QR.

Các endpoint POST: `/api/auth/qr/create`, `/inspect`, `/approve`, `/poll`, `/cancel`. Giữ CSRF guard, cookie HttpOnly/SameSite, rate limit và giới hạn body. Challenge được giữ tạm trong RAM, có giới hạn tổng số; khởi động lại API làm QR cũ hết hiệu lực. Nếu chạy nhiều replica, phải dùng sticky routing cho **cả browser và phone** theo challenge hoặc thay bằng kho giao dịch dùng chung trước khi bật QR; sticky theo cookie từng thiết bị không đủ. Phiên điện thoại và trình duyệt cũng phải dùng cùng backend phiên.

Android dùng Google Code Scanner qua Google Play services; cần Google Play services và có thể cần mạng để tải module lần đầu. iOS dùng camera/AVFoundation; người dùng phải cấp quyền camera. Bản iOS simulator không kiểm chứng camera thật hoặc thay thế IPA được ký cho iPhone.

## Kiểm tra

Kiểm thử challenge hết hạn, chống trình duyệt khác nhận phiên, hủy, CSRF/HTTPS, đổi tài khoản duyệt, thu hồi phiên nguồn và phát lại sau mất phản hồi. UI dùng JMAP giả lập để kiểm tra QR hiển thị, xác nhận qua phiên điện thoại riêng và trình duyệt tự mở hộp thư. Cần kiểm thử camera trên điện thoại thật và đăng nhập production sau khi sửa chứng chỉ HTTPS.
