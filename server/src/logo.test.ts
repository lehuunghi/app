import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLogoUrl, logoCspSource } from "./logo.js";

test("deployment logo accepts local paths and HTTP(S), rejects unsafe URLs", () => {
  assert.equal(normalizeLogoUrl(" /img/logo.svg "), "/img/logo.svg");
  assert.equal(normalizeLogoUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(normalizeLogoUrl(""), "");
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,test", "//evil.example/logo", "/\\evil.example/logo", "https://user:password@example.com/logo"]) {
    assert.throws(() => normalizeLogoUrl(url), /APP_LOGO_URL/);
  }
});

test("logo CSP allows the configured image path only", () => {
  assert.equal(logoCspSource("https://cdn.example.com/brand/logo.png?v=2#logo"), "https://cdn.example.com/brand/logo.png");
  assert.equal(logoCspSource("/img/logo.svg"), "");
  assert.equal(logoCspSource("https://cdn.example.com/a'b.png"), "https://cdn.example.com/a%27b.png");
});
