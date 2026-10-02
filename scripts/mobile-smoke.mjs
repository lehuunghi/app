import { writeFileSync } from "node:fs";

const server = "https://jmail.vn";
const results = [];
async function check(path) {
  try {
    const response = await fetch(server + path, {
      headers: { accept: "application/json", "x-requested-with": "ihasmail" },
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { /* record non-JSON endpoints */ }
    const result = { path, status: response.status, type, json: data !== undefined,
      location: response.headers.get("location"), authenticate: response.headers.get("www-authenticate") };
    if (path === "/api/config") result.appName = data?.appName;
    if (path === "/api/health") result.healthy = data?.ok === true;
    if (data?.error) result.error = data.error;
    if (path === "/.well-known/jmap") result.capabilities = Object.keys(data?.capabilities ?? {});
    if (!data) result.title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1];
    results.push(result);
    return { response, data };
  } catch (error) {
    results.push({ path, error: error.message, cause: error.cause?.code });
    return null;
  }
}
const config = await check("/api/config");
const health = await check("/api/health");
const session = await check("/api/auth/session");
await check("/.well-known/jmap");
await check("/jmap/session");
await check("/jmap/");
await check("/");
const compatible = config?.response.status === 200 && typeof config.data?.appName === "string"
  && health?.data?.ok === true && session?.response.status === 401;
const report = { server, checkedAt: new Date().toISOString(), compatible, results,
  authenticatedMailTest: "Not run: no test account was supplied." };
writeFileSync("mobile-smoke-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!compatible) process.exitCode = 1;
