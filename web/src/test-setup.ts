import { beforeEach } from "vitest";
import { loadLanguage, whenLanguageReady } from "@/lib/i18n";
import { setUiLanguageForFormatting } from "@/lib/datetime";

// Behavioral fixtures assert English labels explicitly. Give each test an
// explicit language rather than tying them to the deployment's default.
// Language tests can still select Vietnamese and verify the real defaults.
beforeEach(async () => {
  await whenLanguageReady();
  await loadLanguage("en");
  setUiLanguageForFormatting("en");
});
