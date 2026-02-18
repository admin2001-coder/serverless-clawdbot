import crypto from "crypto";
import { env, envRequired } from "@/app/lib/env";

export function whatsappVerifyChallenge(url: URL): { ok: boolean; challenge?: string } {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = env("WHATSAPP_VERIFY_TOKEN");
  if (mode === "subscribe" && token && expected && token === expected && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

export function verifyWhatsAppSignature(bodyRaw: string, signatureHeader: string | null): boolean {
  const appSecret = env("WHATSAPP_APP_SECRET");
  if (!appSecret) return true; // skip verification if not configured

  // Meta sends X-Hub-Signature-256: sha256=<hash>
  if (!signatureHeader) return false;
  const [algo, sig] = signatureHeader.split("=", 2);
  if (algo !== "sha256" || !sig) return false;

  const hmac = crypto.createHmac("sha256", appSecret).update(bodyRaw, "utf8").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac));
}

export async function whatsappSendMessage(toE164: string, text: string): Promise<void> {
  const accessToken = envRequired("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = envRequired("WHATSAPP_PHONE_NUMBER_ID");

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toE164.replace("+", ""),
      type: "text",
      text: { body: text, preview_url: false },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed: ${res.status} ${body}`);
  }
}

export function whatsappSessionToTo(sessionId: string): string {
  // sessionId is whatsapp:+15551234567
  const parts = sessionId.split(":");
  return parts[1] ?? "";
}
