import { afterEach, describe, expect, it } from "vitest";
import { currentLanguage, loadLanguage, plural, setCatalog, t, tc } from "@/lib/i18n";
import { catalog } from "@/locales/vi";
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES, resolveUiLanguage } from "@/lib/languages";

const variables = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
afterEach(() => setCatalog("en", { strings: {}, plurals: {} }));

describe("Vietnamese interface", () => {
  it("loads the Vietnamese catalog for the default and an unknown preference", async () => {
    expect(DEFAULT_UI_LANGUAGE).toBe("vi");
    await loadLanguage(resolveUiLanguage(undefined));
    expect(t("Sign in")).toBe("Đăng nhập");
    await loadLanguage("xx-XX");
    expect(currentLanguage()).toBe("vi");
    expect(t("Compose")).toBe("Soạn thư");
  });
  it("loads from the language picker and can switch back to English", async () => {
    expect(UI_LANGUAGES.find((language) => language.tag === "vi")?.name).toBe("Tiếng Việt");
    await loadLanguage("vi");
    expect(currentLanguage()).toBe("vi");
    expect(t("Compose")).toBe("Soạn thư");
    expect(t("Sign in")).toBe("Đăng nhập");
    expect(tc("folder", "Inbox")).toBe("Hộp thư đến");
    expect(t("Could not send the receipt: {error}", { error: "offline" })).toBe("Không thể gửi xác nhận: offline");
    await loadLanguage("en");
    expect(t("Compose")).toBe("Compose");
  });

  it("keeps interpolation variables in every translated message", () => {
    for (const [source, translation] of Object.entries(catalog.strings)) {
      expect(translation.trim(), source).not.toBe("");
      expect(variables(translation), source).toEqual(variables(source));
    }
    for (const [source, forms] of Object.entries(catalog.plurals)) {
      expect(Object.keys(forms), source).toEqual(["other"]);
      expect(variables(forms.other), source).toEqual(variables(source));
    }
  });

  it("uses the same Vietnamese form for zero, one and many", () => {
    setCatalog("vi", catalog);
    for (const n of [0, 1, 2, 21, 100]) {
      expect(plural(n, { one: "{n} message", other: "{n} messages" })).toBe(`${n} thư`);
    }
  });
});
