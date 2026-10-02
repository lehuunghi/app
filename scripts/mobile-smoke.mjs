import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const server = "https://jmail.vn";
const apiServer = "https://webmail.jmail.vn";
const results = [];
async function check(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init, headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "ihasmail" },
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    let data;
    try { data = await response.json(); } catch { /* redirects can have no body */ }
    results.push({ url, method: init.method ?? "GET", status: response.status,
      location: response.headers.get("location"), appName: data?.appName, healthy: data?.ok, error: data?.error });
    return { response, data };
  } catch (error) {
    results.push({ url, error: error.message, cause: error.cause?.code });
    return null;
  }
}
const root = await check(server);
const config = await check(apiServer + "/api/config");
const health = await check(apiServer + "/api/health");
const session = await check(apiServer + "/api/auth/session");
const login = await check(apiServer + "/api/auth/login", {
  method: "POST", body: JSON.stringify({ username: "codex-app-smoke-" + randomUUID() + "@jmail.vn",
    password: randomUUID(), remember: false }),
});
const compatible = root?.response.headers.get("location")?.replace(/\/$/, "") === apiServer
  && config?.response.status === 200 && typeof config.data?.appName === "string"
  && health?.data?.ok === true && session?.response.status === 401
  && login?.response.status === 401 && login.data?.error === "invalid_credentials";
const report = { server, apiServer, checkedAt: new Date().toISOString(), compatible, results,
  authenticatedMailTest: "Not run: no test account was supplied." };
writeFileSync("mobile-smoke-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!compatible) process.exitCode = 1;
