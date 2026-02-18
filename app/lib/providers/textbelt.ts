import { env, envRequired } from "@/app/lib/env";

export type TextbeltSendResponse = {
  success: boolean;
  quotaRemaining?: number;
  textId?: string | number;
  error?: string;
};

export function getTextbeltReplyWebhookUrl(fallbackBaseUrl?: string): string | null {
  const base = env("APP_BASE_URL") ?? fallbackBaseUrl;
  if (!base) return null;
  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalized}/api/claw?op=sms`;
}

export async function textbeltSendSms(args: {
  to: string; // E.164 or 10-digit US
  message: string;
  replyWebhookUrl?: string | null;
  webhookData?: string; // <= 100 chars, optional
}): Promise<TextbeltSendResponse> {
  const key = envRequired("TEXTBELT_API_KEY");

  const body = new URLSearchParams();
  body.set("phone", args.to);
  body.set("message", args.message);
  body.set("key", key);

  const replyWebhookUrl = args.replyWebhookUrl ?? getTextbeltReplyWebhookUrl();
  if (replyWebhookUrl) body.set("replyWebhookUrl", replyWebhookUrl);
  if (args.webhookData) body.set("webhookData", args.webhookData);

  const res = await fetch("https://textbelt.com/text", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });

  const json = (await res.json().catch(() => null)) as any;
  if (!json) throw new Error(`Textbelt send failed: ${res.status} (no JSON)`);
  return json as TextbeltSendResponse;
}

/** Constant-time string compare (hex strings). */
function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;

  // Constant-time compare over UTF-16 code units (safe for hex ascii).
  let diff = 0;
  for (let i = 0; i < aHex.length; i++) diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  return diff === 0;
}

function hexFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i]!.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto API not available in this runtime");

  const enc = new TextEncoder();
  const keyBytes = enc.encode(key);
  const dataBytes = enc.encode(data);

  const cryptoKey = await subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await subtle.sign("HMAC", cryptoKey, dataBytes);
  return hexFromBytes(sig);
}

export async function verifyTextbeltWebhook(args: {
  apiKey: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
}): Promise<boolean> {
  const { apiKey, timestampHeader, signatureHeader, rawBody } = args;
  if (!timestampHeader || !signatureHeader) return false;

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;

  // Recommended: reject if timestamp older/newer than 15 minutes.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 15 * 60) return false;

  // Textbelt signs: HMAC_SHA256(apiKey, timestamp + rawBody) -> hex
  const mySignature = await hmacSha256Hex(apiKey, timestampHeader + rawBody);

  return timingSafeEqualHex(signatureHeader, mySignature);
}

export function shouldVerifyTextbeltWebhook(): boolean {
  // Allow disabling during local debugging (not recommended for prod)
  return env("TEXTBELT_VERIFY_WEBHOOKS") !== "false";
}

export function getTextbeltApiKeyOptional(): string | null {
  return env("TEXTBELT_API_KEY") ?? null;
}
