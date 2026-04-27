import type { Channel } from "@/app/lib/identity";
import { telegramSendMessage } from "@/app/lib/providers/telegram";
import { whatsappSendMessage, whatsappSessionToTo } from "@/app/lib/providers/whatsapp";
import { getTextbeltReplyWebhookUrl, textbeltSendSms } from "@/app/lib/providers/textbelt";
import { getStore } from "@/app/lib/store";
import { safeKeyPart, shortHash } from "@/app/lib/hash";

export type OutboundSendArgs = {
  channel: Channel;
  sessionId: string;
  text: string;
  baseUrlHint?: string;
  idempotencyKey?: string;
  disableNotification?: boolean;
};

async function acquireOutboundDedupe(args: OutboundSendArgs): Promise<{ key: string; acquired: boolean } | null> {
  const idempotencyKey = args.idempotencyKey?.trim();
  if (!idempotencyKey) return null;

  const store = getStore();
  const key = `outbound:dedupe:${safeKeyPart(idempotencyKey, 220)}`;
  const acquired = await store.set(
    key,
    {
      status: "pending",
      channel: args.channel,
      sessionId: args.sessionId,
      textHash: shortHash(args.text, 24),
      startedAt: Date.now(),
    },
    {
      nx: true,
      exSeconds: Math.max(3600, Number(process.env.OUTBOUND_DEDUPE_TTL_SECONDS ?? 60 * 60 * 24 * 14)),
    }
  );

  return { key, acquired };
}

async function markOutboundDedupe(key: string, status: "sent" | "failed", extra?: Record<string, unknown>) {
  const store = getStore();
  await store.set(
    key,
    {
      status,
      finishedAt: Date.now(),
      ...(extra ?? {}),
    } as any,
    {
      exSeconds: Math.max(3600, Number(process.env.OUTBOUND_DEDUPE_TTL_SECONDS ?? 60 * 60 * 24 * 14)),
    }
  );
}

/**
 * Runtime outbound send helper.
 * Safe to call from:
 * - Route handlers (webhooks)
 * - Workflow steps
 */
export async function sendOutboundRuntime(args: OutboundSendArgs) {
  const dedupe = await acquireOutboundDedupe(args);
  if (dedupe && !dedupe.acquired) return { skipped: true, reason: "duplicate_outbound" as const };

  const { channel, sessionId, text, baseUrlHint } = args;

  try {
    if (channel === "telegram") {
      const messageId = await telegramSendMessage(sessionId, text, {
        disableNotification: args.disableNotification,
      });
      if (dedupe) await markOutboundDedupe(dedupe.key, "sent", { telegramMessageId: messageId });
      return { skipped: false, telegramMessageId: messageId };
    }

    if (channel === "whatsapp") {
      const to = whatsappSessionToTo(sessionId);
      if (!to) throw new Error(`Invalid whatsapp sessionId: ${sessionId}`);
      await whatsappSendMessage(to, text);
      if (dedupe) await markOutboundDedupe(dedupe.key, "sent");
      return { skipped: false };
    }

    if (channel === "sms") {
      const to = sessionId.split(":")[1] ?? "";
      if (!to) throw new Error(`Invalid sms sessionId: ${sessionId}`);

      const replyWebhookUrl = getTextbeltReplyWebhookUrl(baseUrlHint);

      const resp = await textbeltSendSms({
        to,
        message: text,
        replyWebhookUrl,
      });

      if (!resp.success) {
        throw new Error(`Textbelt send failed: ${resp.error ?? "unknown error"}`);
      }

      if (dedupe) await markOutboundDedupe(dedupe.key, "sent", { textbelt: resp as any });
      return { skipped: false, textbelt: resp };
    }

    throw new Error(`Unsupported channel: ${channel}`);
  } catch (error: any) {
    if (dedupe) {
      await markOutboundDedupe(dedupe.key, "failed", {
        error: String(error?.message ?? error ?? "Unknown outbound send error"),
      });
      // Allow a future retry after the provider failure instead of permanently black-holing the message.
      await getStore().del(dedupe.key);
    }
    throw error;
  }
}
