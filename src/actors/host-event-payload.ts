import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";

interface FabricActorHostMediaDescriptor {
  type: "image";
  mediaIndex: number;
  mimeType: string;
}

export interface PreparedFabricActorHostPayload {
  payload: unknown;
  images: ImageContent[];
  media: FabricActorHostMediaDescriptor[];
}

const normalizedKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return [
    "password",
    "passwd",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "apikey",
    "privatekey",
    "clientsecret",
  ].some((sensitive) => normalized === sensitive || normalized.endsWith(sensitive));
};

const redactInlineSecrets = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*[^\r\n;]+/gi,
      "$1: [redacted]",
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@");

const looksLikeBase64 = (value: string): boolean => {
  if (value.startsWith("data:") && value.includes(";base64,")) return true;
  if (value.length < 1_024 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=_\r\n-]+$/.test(value);
};

const isImageContent = (value: unknown): value is ImageContent =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { type?: unknown }).type === "image" &&
  typeof (value as { data?: unknown }).data === "string" &&
  typeof (value as { mimeType?: unknown }).mimeType === "string";

export const prepareFabricActorHostPayload = (
  value: unknown,
  maxChars: number,
): PreparedFabricActorHostPayload => {
  const images: ImageContent[] = [];
  const media: FabricActorHostMediaDescriptor[] = [];
  const imageIndexes = new Map<string, number>();
  const seen = new WeakSet<object>();
  let json: string;

  try {
    const serialized = JSON.stringify(value, (key, nested) => {
      if (key && isSensitiveKey(key)) return "[redacted]";
      if (isImageContent(nested)) {
        const sha256 = createHash("sha256")
          .update(nested.mimeType)
          .update("\0")
          .update(nested.data)
          .digest("hex");
        let mediaIndex = imageIndexes.get(sha256);
        if (mediaIndex === undefined) {
          mediaIndex = images.length;
          imageIndexes.set(sha256, mediaIndex);
          images.push({ type: "image", data: nested.data, mimeType: nested.mimeType });
          media.push({ type: "image", mediaIndex, mimeType: nested.mimeType });
        }
        return {
          type: "image",
          mediaIndex,
          mimeType: nested.mimeType,
          redacted: true,
        };
      }
      if (
        typeof nested === "object" &&
        nested !== null &&
        !Array.isArray(nested) &&
        (nested as { type?: unknown }).type === "image"
      ) {
        return {
          type: "image",
          ...(typeof (nested as { mimeType?: unknown }).mimeType === "string"
            ? { mimeType: (nested as { mimeType: string }).mimeType }
            : {}),
          redacted: true,
        };
      }
      if (typeof nested === "string") {
        if (looksLikeBase64(nested)) return "[omitted base64]";
        return redactInlineSecrets(nested);
      }
      if (typeof nested === "bigint") return String(nested);
      if (typeof nested === "function" || typeof nested === "symbol") return undefined;
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[circular or repeated reference]";
        seen.add(nested);
      }
      return nested;
    });
    json = serialized ?? "null";
  } catch {
    json = JSON.stringify(String(value));
  }

  if (json.length > maxChars) json = json.slice(json.length - maxChars);
  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch {
    payload = json;
  }
  return { payload, images, media };
};
