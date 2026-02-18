import type { InboundMessage } from "@/app/lib/normalize";
import { csvEnv } from "@/app/lib/env";
import { makeIdentity, isAdmin, isAllowed as kvIsAllowed } from "@/app/lib/identity";

/**
 * OpenClaw/ZeroClaw allowlist semantics:
 * - If channel allowlist env var is set:
 *   - empty list => deny all
 *   - "*" => allow all
 *   - otherwise => exact match on sender ID (and for Telegram, username if provided)
 *
 * Serverless dynamic mode:
 * - If allowlist env var is NOT set, we fall back to KV-based pairing allowlist.
 */
function envAllowlistForChannel(channel: InboundMessage["channel"]): string[] | null {
  if (channel === "telegram") {
    const v = process.env.TELEGRAM_ALLOWED_USERS;
    if (v == null) return null;
    return csvEnv("TELEGRAM_ALLOWED_USERS");
  }
  if (channel === "whatsapp") {
    const v = process.env.WHATSAPP_ALLOWED_NUMBERS;
    if (v == null) return null;
    return csvEnv("WHATSAPP_ALLOWED_NUMBERS");
  }
  if (channel === "sms") {
    const v = process.env.SMS_ALLOWED_NUMBERS;
    if (v == null) return null;
    return csvEnv("SMS_ALLOWED_NUMBERS");
  }
  return null;
}

export async function isInboundAllowed(msg: InboundMessage): Promise<{ allowed: boolean; reason?: string }> {
  const identity = makeIdentity(msg.channel, msg.senderId);

  if (await isAdmin(identity)) return { allowed: true };

  const envList = envAllowlistForChannel(msg.channel);
  if (envList !== null) {
    if (envList.length === 0) {
      return { allowed: false, reason: "Channel allowlist is empty (deny-by-default)." };
    }
    if (envList.includes("*")) return { allowed: true };

    const candidates = new Set<string>([
      msg.senderId,
      identity,
      (msg as any).senderUsername ? String((msg as any).senderUsername) : "",
      (msg as any).senderUsername ? `@${String((msg as any).senderUsername)}` : "",
    ].filter(Boolean));

    for (const entry of envList) {
      if (candidates.has(entry)) return { allowed: true };
    }
    return { allowed: false, reason: "Sender not in env allowlist." };
  }

  // Fallback: KV-based allowlist (paired users)
  const ok = await kvIsAllowed(identity);
  return { allowed: ok, reason: ok ? undefined : "Sender not paired (KV allowlist)." };
}
