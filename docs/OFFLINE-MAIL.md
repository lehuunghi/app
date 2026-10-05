# Thư ngoại tuyến Android/iOS — phiên bản 1.2.0

Ứng dụng tải nội dung thư, ảnh nội bộ và tệp đính kèm vào bộ nhớ riêng. Mở lại thư đã tải dùng bản trên máy. Thay đổi cờ đọc, đánh dấu sao, chuyển/xóa thư, tạo thư mục, lưu bản nháp và gửi thư được ghi vào hàng đợi bền vững trước khi báo thành công. Khi kết nối lại, đồng bộ các thao tác rồi lấy thay đổi từ máy chủ. Email có nội dung bất biến: sửa bản nháp tạo phiên bản mới, không sửa nội dung thư đã gửi.

Mặc định tải tối đa 1.000 thư trong 30 ngày gần đây cho lần đầu. Các thư mới sau đó được lấy qua Email/changes; thư cũ được mở online cũng được giữ lại để tải đầy đủ. Cài đặt cho phép 7/30/90/365 ngày và giới hạn 100/500/1.024 MiB. Khi đầy bộ nhớ, tải dừng và hiện trạng thái; không tự xóa bản nháp hoặc thư chờ gửi. Số lượng thư và kết quả tìm kiếm offline chỉ bao gồm thư đã lưu. Ảnh ngoài từ máy chủ người gửi không tự tải, giữ nguyên chính sách riêng tư. Xem mã nguồn MIME đầy đủ hoặc các tính năng lịch, danh bạ, Files vẫn cần mạng nếu chưa có bản riêng; kho offline này dành cho email.

## Lưu trữ và phiên đăng nhập

- Android: SQLite, từng bản ghi mã hóa AES-256-GCM, khóa trong Android Keystore. Bản ghi lớn chia thành các phần để tránh giới hạn CursorWindow.
- iOS: SQLite và CryptoKit AES-GCM, khóa Keychain AfterFirstUnlockThisDeviceOnly. Loại dữ liệu khỏi sao lưu; có thể đồng bộ sau lần mở khóa máy đầu tiên.
- JavaScript không giữ khóa mã hóa hoặc mật khẩu. Native worker giữ cookie phiên trong kho mã hóa, chỉ gửi tới https://webmail.jmail.vn; không theo chuyển hướng.
- Chỉ bật kho riêng cho tài khoản cá nhân và thiết bị được ghi nhớ. Máy chủ cũ vẫn dùng các thao tác online thông thường; ghi offline và đồng bộ nền chỉ bật khi phiên trả `ihasmail.offlineSync: 1`.
- Mất mạng cho phép mở lại phiên đã tin cậy và dữ liệu đã tải. Nếu máy chủ đã trả 401, phải đăng nhập lại; dữ liệu chưa gửi được giữ cho cùng tài khoản. Đăng xuất chủ động xóa kho, khóa, bản nháp và hàng đợi trên máy, dừng job và xóa cookie.

## Tránh gửi trùng và xung đột

Mỗi thao tác có UUID cố định, dùng chung khi foreground và native worker thử lại. Máy chủ lưu dấu đã bắt đầu trước khi gọi JMAP, fsync, lưu phản hồi mã hóa. Kiểm tra lại bản ghi sau khi lấy khóa để tránh hai yêu cầu cùng thực thi. Băm dữ liệu theo thứ tự khóa chuẩn, nên Android, iOS và JavaScript có thể dùng cùng UUID dù thứ tự thuộc tính JSON khác nhau.

Nếu mất phản hồi, không phát lại mù quáng. Gửi thư có header X-Webmail-Operation-ID; đối chiếu EmailSubmission để xác nhận. Nếu chưa đủ bằng chứng, giữ trạng thái “cần xác minh”. Không cam kết “exactly once” trên JMAP: upstream không có transaction xuyên qua máy chủ trung gian. Ưu tiên không gửi trùng, chấp nhận một số thao tác phải kiểm tra thủ công. Thư mới chỉ rời Hộp thư đi khi được máy chủ xác nhận; gửi thất bại một phần vẫn giữ nội dung để xem lại. Xác nhận gửi không có nghĩa người nhận đã nhận được thư.

Trước khi cập nhật cờ/thư mục, so sánh các trường thực sự bị sửa với bản gốc và ý định mới; dùng ifInState để ngăn thay đổi trong lúc kiểm tra. Xung đột được giữ trong phần Thư ngoại tuyến; không tự ghi đè thay đổi trên webmail. Không tự thử lại thao tác đã bị JMAP từ chối. Xóa offline ẩn ngay trên máy, giữ dữ liệu để hủy trước khi xác nhận. Hủy thao tác phải hủy các thao tác phụ thuộc phía sau trước.

## Đồng bộ nền

Android dùng JobScheduler có điều kiện mạng, job định kỳ tối thiểu 15 phút, thêm job khi có push hoặc app chuyển nền. Thiết bị mới đăng ký khả năng offline để nhận FCM data message; dịch vụ native hiện thông báo chung và lên lịch tải. Thiết bị cũ vẫn nhận notification payload cũ.

iOS dùng BGAppRefreshTask và remote notification content-available. Hệ điều hành quyết định thời điểm chạy và có thể không chạy sau force-quit hoặc khi hạn chế pin. Worker có giới hạn thời gian, lưu metadata/cursor trong cùng giao dịch và tiếp tục các nội dung/tệp chưa hoàn tất ở lượt sau. Không hứa tải ngay mọi thư khi app bị đóng. Mở app tiếp tục đồng bộ.

## Triển khai bắt buộc

Cập nhật server cùng commit với app, giữ nguyên `APP_SECRET` và `SESSION_FILE` trong thư mục dữ liệu bền vững. Có thể đặt `OFFLINE_OPERATIONS_DIR=/data/offline-operations`; mặc định là `${SESSION_FILE}.offline`. Thư mục phải ghi được và phải được sao lưu cùng phiên. Không xóa journal để “sửa” thư đang cần xác minh: việc đó mất bằng chứng chống gửi trùng. Hiện chưa có chính sách xóa journal tự động; cần theo dõi dung lượng máy chủ.

Nhánh này thêm POST `/api/offline/jmap/:uuid` và `/api/offline/pull`, đều yêu cầu phiên, CSRF header và tài khoản cá nhân. Journal hỗ trợ khóa file; nhiều replica phải dùng cùng kho file có thao tác khóa/rename/fsync đúng hoặc thay bằng kho giao dịch dùng chung. NATIVE_PUSH_FILE vẫn chỉ có một process chủ.

Firebase/APNs cần cấu hình riêng theo [THONG-BAO-NATIVE.md](THONG-BAO-NATIVE.md). Chứng chỉ HTTPS phải hợp lệ; không tắt xác minh TLS. Build simulator iOS không phải IPA cài iPhone.

## Xác minh

Kiểm thử kho/hàng đợi với khởi động lại, không tải lại dữ liệu đã có, cờ đọc/sao/chuyển/xóa, attachment offline, hủy gửi, ghi đĩa lỗi, stale cursor và logout. Journal kiểm tra mã hóa, nhận lại kết quả sau restart, JSON khác thứ tự, yêu cầu đồng thời và kết quả gửi chưa xác định. Native pull kiểm tra delta, baseline và xóa thư cũ khi mất cursor.

Kiểm tra mã nguồn và simulator không thay thế kiểm thử gửi/nhận thật, push trên điện thoại thật, hết dung lượng, tắt app giữa lúc ghi hoặc chế độ tiết kiệm pin. Không có tài khoản kiểm thử sản xuất trong phiên làm việc này.
