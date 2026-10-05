/** Browser QR sign-in with a separate authenticated phone fixture; camera tested separately. */
export async function qrUiSmoke(browser) {
  const web = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const phone = await browser.newContext();
  const headers = { "x-requested-with": "ihasmail", "content-type": "application/json" };
  try {
    const page = await web.newPage();
    await page.goto("http://127.0.0.1:8080");
    const creation = page.waitForResponse((r) => r.url().endsWith("/api/auth/qr/create") && r.request().method() === "POST");
    await page.locator('.login-mode-tabs button').nth(1).click();
    const challenge = await (await creation).json();
    await page.locator('.qr-login-panel svg').waitFor();
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge.id)) throw new Error("No QR challenge");
    if (await page.locator('#p').count()) throw new Error("Password form still visible in QR mode");
    await page.screenshot({ path: "ui-smoke/qr-login.png", fullPage: true });
    const signIn = await phone.request.post("http://127.0.0.1:8080/api/auth/login", { headers, data: { username: "demo", password: "demo", remember: true } });
    if (!signIn.ok()) throw new Error("Phone fixture sign-in failed");
    const inspect = await phone.request.post("http://127.0.0.1:8080/api/auth/qr/inspect", { headers, data: { id: challenge.id } });
    if (!inspect.ok() || (await inspect.json()).code !== challenge.code) throw new Error("Phone/browser code mismatch");
    const approved = await phone.request.post("http://127.0.0.1:8080/api/auth/qr/approve", { headers, data: { id: challenge.id } });
    if (!approved.ok()) throw new Error("QR approval failed");
    await page.locator('.msg-row').first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: "ui-smoke/qr-login-approved.png", fullPage: true });
    return { renderedQR: true, separatePhoneSession: true, codeMatched: true, automaticBrowserSignIn: true, camera: "not simulated" };
  } finally { await web.close(); await phone.close(); }
}
