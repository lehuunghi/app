# Container Webmail App trên GHCR

Image: `ghcr.io/lehuunghi/app:latest`.

Image chứa phần web và API Node.js của kho `app`, phục vụ cổng `8080`.
Android APK và bản iOS simulator được phát hành bằng workflow mobile hiện có
trên [GitHub Releases](https://github.com/lehuunghi/app/releases).

## Tự động xuất bản

Workflow [Publish GHCR](https://github.com/lehuunghi/app/actions/workflows/ghcr.yml)
chạy khi push/merge vào `main`, push tag `v*` hoặc chọn **Run workflow**.

- `main`: cập nhật `latest`, `main` và `sha-<commit>`.
- Tag `v1.2.3`: tạo `v1.2.3`, `1.2.3` và tag commit.
- Tag cũ hoặc chạy từ nhánh khác không ghi đè `latest`.
- Pull request không xuất bản image.

Trước khi build, workflow chạy typecheck, kiểm thử web/API và kiểm tra bản dịch.
Hai kiến trúc `linux/amd64` và `linux/arm64` được build trên runner tương ứng.
Mỗi container được kiểm tra khởi động, `/api/health` và trang web; chỉ khi cả hai
thành công, workflow mới ghép manifest và cập nhật tag.

Workflow dùng `GITHUB_TOKEN` với `contents: read` và `packages: write`.
Không cần token cá nhân hoặc token Docker Hub.

## Tải và triển khai

```sh
docker pull ghcr.io/lehuunghi/app:latest
```

Dùng các biến môi trường của [.env.example](../.env.example), tối thiểu
`STALWART_URL` và `APP_SECRET`. Đặt HTTPS reverse proxy trước cổng `8080` và
gắn volume tại `/data` để giữ phiên đăng nhập.

Để dùng image với cấu hình Compose hiện có, đặt `image: ghcr.io/lehuunghi/app:latest`
trong service `webmail`, bỏ mục `build`, rồi chạy `docker compose pull` và
`docker compose up -d`. Image sẵn dùng chạy ở gốc tên miền; khi phục vụ dưới một
subpath như `/mail`, build riêng với `--build-arg BASE_PATH=/mail`.

Nếu package riêng tư, đăng nhập GHCR bằng tài khoản có quyền đọc trước khi pull.
Muốn tải không đăng nhập, đặt **Public** trong
[Package settings](https://github.com/users/lehuunghi/packages/container/package/app).
Nếu package cùng tên đã tồn tại, cấp quyền Actions cho repository `lehuunghi/app`
trong **Package settings → Manage Actions access**.
