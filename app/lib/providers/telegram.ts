// app/lib/providers/telegram.ts
import { env, envRequired } from "@/app/lib/env";

type TelegramApiOk<T> = { ok: true; result: T };
type TelegramApiErr = { ok: false; description?: string; error_code?: number };

type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export function telegramSessionToChatAndThread(sessionId: string): { chatId: string; threadId?: number } {
  // sessionId: telegram:<chatId> or telegram:<chatId>:<threadId>
  const parts = String(sessionId ?? "").split(":");
  const chatId = parts[1] ?? "";
  const threadId = parts.length >= 3 ? Number(parts[2]) : undefined;
  return { chatId, threadId: Number.isFinite(threadId as any) ? threadId : undefined };
}

export async function telegramValidateWebhook(req: Request): Promise<boolean> {
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return true;
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  return got === secret;
}

async function telegramApiCall<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const token = envRequired("TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();

  let parsed: TelegramApiOk<T> | TelegramApiErr | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ignore
  }

  if (parsed && (parsed as any).ok === false) {
    const err = parsed as TelegramApiErr;
    const code = err.error_code ?? res.status;
    const desc = err.description ?? raw;
    throw new Error(`Telegram ${method} failed: ${code} ${desc}`);
  }

  if (!res.ok) throw new Error(`Telegram ${method} HTTP ${res.status}: ${raw}`);
  if (!parsed || (parsed as any).ok !== true) throw new Error(`Telegram ${method} bad response: ${raw}`);

  return (parsed as TelegramApiOk<T>).result;
}

export async function telegramSendChatAction(sessionId: string, action: TelegramChatAction): Promise<void> {
  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const payload: any = { chat_id: chatId, action };
  if (threadId) payload.message_thread_id = threadId;

  await telegramApiCall("sendChatAction", payload);
}

export function telegramStartChatActionLoop(
  sessionId: string,
  action: TelegramChatAction,
  opts?: { intervalMs?: number }
): { stop: () => void } {
  const intervalMs = Math.max(1000, Number(opts?.intervalMs ?? env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
  let stopped = false;

  (async () => {
    while (!stopped) {
      try {
        await telegramSendChatAction(sessionId, action);
      } catch {
        // best-effort
      }
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  })();

  return { stop: () => (stopped = true) };
}

export async function telegramSendMessage(
  sessionId: string,
  text: string,
  opts?: { disableWebPreview?: boolean; disableNotification?: boolean }
): Promise<number> {
  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const payload: any = {
    chat_id: chatId,
    text: text ?? "",
    disable_web_page_preview: opts?.disableWebPreview ?? true,
    disable_notification: opts?.disableNotification ?? false,
  };
  if (threadId) payload.message_thread_id = threadId;

  const result = await telegramApiCall<{ message_id: number }>("sendMessage", payload);
  return result.message_id;
}

export async function telegramEditMessageText(
  sessionId: string,
  messageId: number,
  text: string,
  opts?: { disableWebPreview?: boolean }
): Promise<void> {
  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const payload: any = {
    chat_id: chatId,
    message_id: messageId,
    text: text ?? "",
    disable_web_page_preview: opts?.disableWebPreview ?? true,
  };
  if (threadId) payload.message_thread_id = threadId;

  try {
    await telegramApiCall("editMessageText", payload);
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    if (msg.includes("message is not modified")) return;
    throw err;
  }
}
