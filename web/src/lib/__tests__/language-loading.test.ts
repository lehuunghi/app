import { afterEach, describe, expect, it } from "vitest";
import { currentLanguage, loadLanguage, t } from "@/lib/i18n";
import { DEFAULT_UI_LANGUAGE } from "@/lib/languages";

afterEach(() => loadLanguage("en"));

describe("loading interface languages", () => {
  it("loads the Vietnamese catalog for the default and invalid preferences", async () => {
    for (const tag of [DEFAULT_UI_LANGUAGE, "xx-XX"]) {
      await loadLanguage(tag);
      expect(currentLanguage()).toBe("vi");
      expect(t("Sign in")).toBe("Đăng nhập");
    }
  });
  it("can switch back to English without trying to import a missing catalog", async () => {
    await loadLanguage("vi");
    await loadLanguage("en");
    expect(currentLanguage()).toBe("en");
    expect(t("Sign in")).toBe("Sign in");
  });
});
