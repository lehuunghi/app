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
for (let i = 0; i < 6; i++) {
  const data = JSON.parse(gh("api", "repos/" + repo + "/actions/runs?head_sha=" + sha + "&per_page=20"));
  const ci = data.workflow_runs.find((run) => run.head_sha === sha && run.path === ".github/workflows/ci.yml");
  if (ci?.status === "completed") {
    if (ci.conclusion !== "success") throw new Error("Source checks did not pass: " + ci.conclusion);
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
writeFileSync("release-builds/notes.md", "Webmail Android/iOS " + version + " (build " + build + ").\n\nGiao diện đồng bộ từ lehuunghi/webmail bfd7320612cba7eba905365db6c79a40514f0369; dịch vụ cố định https://jmail.vn, API https://webmail.jmail.vn.\n\nĐã đạt kiểm tra mã nguồn, giao diện bằng JMAP giả lập và mở app trên simulator Android/iOS. Android kiểm tra đăng nhập sai với máy chủ thật. Gửi/nhận thư thật cần tài khoản kiểm thử.\n\nAPK debug để cài thử. ZIP iOS chỉ dành cho simulator, chưa phải IPA cho iPhone.\n\nMã nguồn: " + sha + ".\n");
if (existing.status !== 0) gh("release", "create", tag, "--repo", repo, "--target", sha, "--draft", "--prerelease", "--title", "Webmail " + version + " (build " + build + ")", "--notes-file", "release-builds/notes.md");
gh("release", "upload", tag, "--repo", repo, "--clobber", "release-builds/publish/" + apk, "release-builds/publish/" + ios, "release-builds/publish/SHA256SUMS.txt");
gh("release", "edit", tag, "--repo", repo, "--draft=false");
console.log("Published https://github.com/" + repo + "/releases/tag/" + tag);
