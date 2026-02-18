import { envRequired, env } from "@/app/lib/env";

export async function telegramValidateWebhook(req: Request): Promise<boolean> {
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return true;
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  return got === secret;
}

export function telegramSessionToChatAndThread(sessionId: string): { chatId: string; threadId?: number } {
  // sessionId examples:
  // telegram:<chatId> or telegram:<chatId>:<threadId>
  const parts = sessionId.split(":");
  const chatId = parts[1] ?? "";
  const threadId = parts.length >= 3 ? Number(parts[2]) : undefined;
  return { chatId, threadId: Number.isFinite(threadId as any) ? threadId : undefined };
}

export async function telegramSendMessage(sessionId: string, text: string): Promise<void> {
  const token = envRequired("TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const payload: any = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = threadId;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
