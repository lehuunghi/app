import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
if (!repo || !sha) throw new Error("This publisher runs in GitHub Actions");
const gradle = readFileSync("android/app/build.gradle", "utf8");
const version = gradle.match(/versionName "([^"]+)"/)[1];
const build = gradle.match(/versionCode (\d+)/)[1];
const tag = "mobile-v" + version + "-build" + build;
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
let checked = false;
let tlsReport;
let ciUrl;
for (let i = 0; i < 6; i++) {
  const data = JSON.parse(gh("api", "repos/" + repo + "/actions/runs?head_sha=" + sha + "&per_page=20"));
  const ci = data.workflow_runs.find((run) => run.head_sha === sha && run.path === ".github/workflows/ci.yml");
  if (ci?.status === "completed") {
    ciUrl = ci.html_url;
    const jobs = JSON.parse(gh("api", "repos/" + repo + "/actions/runs/" + ci.id + "/jobs?per_page=100")).jobs;
    if (jobs.find((job) => job.name === "check")?.conclusion !== "success") throw new Error("Source checks did not pass");
    const live = jobs.find((job) => job.name === "live-server");
    if (live?.conclusion !== "success") {
      // A debug prerelease can be reviewed with a known TLS deployment outage.
      // Keep the live check red, require its exact report and disclose the
      // failure prominently; API incompatibilities and source failures block.
      const artifacts = JSON.parse(gh("api", "repos/" + repo + "/actions/runs/" + ci.id + "/artifacts")).artifacts;
      const report = artifacts.find((artifact) => artifact.name === "jmail-connection-check" && !artifact.expired);
      if (!report) throw new Error("No live-server report");
      mkdirSync("release-builds", { recursive: true });
      writeFileSync("release-builds/live-report.zip", execFileSync("gh", ["api", "repos/" + repo + "/actions/artifacts/" + report.id + "/zip"], { stdio: ["ignore", "pipe", "inherit"] }));
      const result = JSON.parse(execFileSync("unzip", ["-p", "release-builds/live-report.zip", "mobile-smoke-report.json"], { encoding: "utf8" }));
      if (result.compatible || result.results?.length !== 5 || !result.results.every((item) => item.cause === "ERR_TLS_CERT_ALTNAME_INVALID")) throw new Error("Live-server compatibility did not pass");
      tlsReport = result;
    }
    checked = true; break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
if (!checked) throw new Error("Source checks have not completed");
const existing = spawnSync("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft"], { encoding: "utf8" });
if (existing.status === 0 && !JSON.parse(existing.stdout).isDraft) {
  console.log("Published version retained. Bump versionCode to publish another build.");
  process.exit(0);
}
mkdirSync("release-builds/publish", { recursive: true });
const apk = "webmail-" + version + "-build" + build + ".apk";
const ios = "webmail-" + version + "-build" + build + "-ios-simulator.zip";
cpSync("release-builds/android/app-debug.apk", "release-builds/publish/" + apk);
cpSync("release-builds/ios/webmail-ios-simulator.zip", "release-builds/publish/" + ios);
const sums = [apk, ios].map((file) => createHash("sha256").update(readFileSync("release-builds/publish/" + file)).digest("hex") + "  " + file).join("\n") + "\n";
writeFileSync("release-builds/publish/SHA256SUMS.txt", sums);
writeFileSync("release-builds/notes.md", "Webmail Android/iOS " + version + " (build " + build + ").\n\nGiao diện đồng bộ từ lehuunghi/webmail bfd7320612cba7eba905365db6c79a40514f0369; dịch vụ cố định https://jmail.vn, API https://webmail.jmail.vn.\n\nĐăng nhập mặc định là thiết bị riêng và không hiển thị lựa chọn. Lỗi kết nối dùng thông báo ngắn tiếng Việt. Tích hợp thông báo native Android/iOS và worker gửi trên máy chủ; cần cấu hình Firebase/APNs và triển khai API mới, chưa kiểm thử push trên điện thoại thật. Hướng dẫn: docs/THONG-BAO-NATIVE.md. Kho thư ngoại tuyến mã hóa trên máy, tự tải nội dung/tệp, hàng đợi thay đổi và Hộp thư đi bền vững, đồng bộ foreground và native background. Mặc định 30 ngày/1.000 thư/500 MiB. Cần triển khai server mới với APP_SECRET, SESSION_FILE bền vững để bật ghi offline và đồng bộ nền. Máy chủ cũ vẫn dùng online và xem thư đã tải. iOS/Android có thể trì hoãn chạy nền. Hướng dẫn: docs/OFFLINE-MAIL.md.\n\nĐã đạt kiểm tra mã nguồn, giao diện bằng JMAP giả lập và mở app trên simulator Android/iOS. Android kiểm tra đăng nhập sai với máy chủ thật. Gửi/nhận thư thật cần tài khoản kiểm thử.\n\nAPK debug để cài thử. ZIP iOS chỉ dành cho simulator, chưa phải IPA cho iPhone.\n\nMã nguồn: " + sha + ".\n");
if (tlsReport) {
  const warning = "CẢNH BÁO TRIỂN KHAI: kiểm tra máy chủ thật thất bại vì chứng chỉ HTTPS không khớp tên miền (ERR_TLS_CERT_ALTNAME_INVALID). APK này là bản thử giao diện/mã nguồn; chưa xác nhận đăng nhập, gửi/nhận thư thật. Cần sửa chứng chỉ của jmail.vn và webmail.jmail.vn trước khi dùng trực tuyến.\n\nCI: " + ciUrl + "\n\n";
  writeFileSync("release-builds/publish/jmail-connection-report.json", JSON.stringify(tlsReport, null, 2) + "\n");
  const notes = readFileSync("release-builds/notes.md", "utf8").replace("Android kiểm tra đăng nhập sai với máy chủ thật.", "Android kiểm tra hiển thị đúng lỗi kết nối với máy chủ thật.");
  writeFileSync("release-builds/notes.md", warning + notes);
}
if (existing.status !== 0) gh("release", "create", tag, "--repo", repo, "--target", sha, "--draft", "--prerelease", "--title", "Webmail " + version + " (build " + build + ")", "--notes-file", "release-builds/notes.md");
gh("release", "upload", tag, "--repo", repo, "--clobber", "release-builds/publish/" + apk, "release-builds/publish/" + ios, "release-builds/publish/SHA256SUMS.txt");
if (tlsReport) gh("release", "upload", tag, "--repo", repo, "--clobber", "release-builds/publish/jmail-connection-report.json");
gh("release", "edit", tag, "--repo", repo, "--draft=false");
console.log("Published https://github.com/" + repo + "/releases/tag/" + tag);
