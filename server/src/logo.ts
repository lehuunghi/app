/** A deployment logo may be local or hosted over HTTP(S). */
export function normalizeLogoUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//") && !/[\\\s]/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new Error("APP_LOGO_URL must be an HTTP(S) URL or an absolute local path");
  }
}

export function logoCspSource(value: string): string {
  if (!value || value.startsWith("/")) return "";
  const url = new URL(value);
  return `${url.origin}${url.pathname}`.replace(/'/g, "%27");
}
