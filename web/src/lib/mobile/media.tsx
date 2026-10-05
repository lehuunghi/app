import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { isNativeApiResource, isNativeApp } from "./config";
import type { SanitizeResult } from "@/lib/text/html";
import { client } from "@/jmap/client";

async function nativeMediaBlob(input: string): Promise<Blob> {
  const url = new URL(input);
  const match = /\/api\/blob\/([^/]+)\/([^/]+)\//.exec(url.pathname);
  if (match) return client.fetchBlob(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), url.searchParams.get("accept") || "application/octet-stream");
  const response = await fetch(input, { credentials: "include" });
  if (!response.ok) throw new Error("Media unavailable");
  return response.blob();
}

export function useNativeResourceUrl(input: string | null): string | null {
  const [loaded, setLoaded] = useState<{ input: string; url: string } | null>(null);
  useEffect(() => {
    if (!input || !isNativeApiResource(input)) return;
    let live = true;
    let objectUrl: string | null = null;
    void nativeMediaBlob(input).then(async (blob) => {
      if (!live) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ input, url: objectUrl });
    }).catch(() => { /* the original controls still offer download/share */ });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [input]);
  if (!input || !isNativeApiResource(input)) return input;
  return loaded?.input === input ? loaded.url : null;
}

export function NativeImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const url = useNativeResourceUrl(typeof src === "string" ? src : null);
  return <img {...props} src={url ?? undefined} />;
}

/** Fetch only URLs produced by the sanitizer and scoped to our own API. */
export function useNativeEmailMedia(input: SanitizeResult | null): SanitizeResult | null {
  const [loaded, setLoaded] = useState<{ input: SanitizeResult; result: SanitizeResult } | null>(null);
  useEffect(() => {
    if (!isNativeApp() || !input) return;
    let live = true;
    const objectUrls: string[] = [];
    const doc = new DOMParser().parseFromString(input.html, "text/html");
    const urls = new Set<string>();
    for (const element of doc.querySelectorAll("[src],[background]")) {
      for (const attr of ["src", "background"]) {
        const value = element.getAttribute(attr);
        if (value && isNativeApiResource(value)) urls.add(value);
      }
    }
    const css = input.bodyStyle + "\n" + [...doc.querySelectorAll("[style],style")].map((el) => el.getAttribute("style") ?? el.textContent ?? "").join("\n");
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (match[1] && isNativeApiResource(match[1])) urls.add(match[1]);
    }
    void Promise.all([...urls].map(async (url) => {
      try {
        const blob = await nativeMediaBlob(url);
        if (!live || !/^image\/(?!svg\+xml)/i.test(blob.type)) return [url, ""] as const;
        const local = URL.createObjectURL(blob);
        objectUrls.push(local);
        return [url, local] as const;
      } catch { return [url, ""] as const; }
    })).then((pairs) => {
      if (!live) return;
      const replace = (value: string) => pairs.reduce((s, [url, local]) => s.split(url).join(local), value);
      for (const element of doc.querySelectorAll("[src],[background],[style],style")) {
        for (const attr of ["src", "background", "style"]) {
          const value = element.getAttribute(attr);
          if (value) element.setAttribute(attr, replace(value));
        }
        if (element.tagName === "STYLE") element.textContent = replace(element.textContent ?? "");
      }
      setLoaded({ input, result: { ...input, html: doc.body.innerHTML, bodyStyle: replace(input.bodyStyle) } });
    });
    return () => { live = false; for (const url of objectUrls) URL.revokeObjectURL(url); };
  }, [input]);
  return loaded?.input === input ? loaded.result : input;
}
