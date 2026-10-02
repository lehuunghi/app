import { beforeEach } from "vitest";
import { loadLanguage, whenLanguageReady } from "@/lib/i18n";

// Upstream tests use English expectations; locale-specific tests select their
// own language. Wait for settings-module initialization before resetting it.
beforeEach(async () => {
  await whenLanguageReady();
  await loadLanguage("en");
});
