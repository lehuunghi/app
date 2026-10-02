import { useState } from "react";
import { withBase } from "@/lib/basePath";
import { useSession } from "@/store/session";
import { isNativeApp, mobileApiServerUrl } from "@/lib/mobile/config";

export function BrandLogo({ url, size }: { url?: string; size?: number }) {
  const configured = useSession((s) => s.session?.ihasmail?.logoUrl);
  const configuredSource = url ?? configured;
  const source = isNativeApp() && configuredSource?.startsWith("/")
    ? new URL(configuredSource, mobileApiServerUrl()).href
    : configuredSource;
  const [failed, setFailed] = useState<string>();
  return <img src={source && failed !== source ? source : withBase("/img/webmail.svg")} alt="" width={size} height={size} style={{ objectFit: "contain" }} referrerPolicy="no-referrer" onError={() => setFailed(source)} />;
}
