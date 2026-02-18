import type { Channel } from "@/app/lib/identity";

export type InboundMessage = {
  channel: Channel;
  sessionId: string; // stable per conversation
  senderId: string;  // user id / phone number
  senderUsername?: string; // only available on some platforms (e.g. Telegram)
  text: string;
  ts: number;
  raw?: unknown;
};

// app/lib/normalize.ts
import { telegramFileIdToBase64 } from "@/app/lib/telegramMedia";
// If your InboundMessage type is in THIS file, delete the import above and use your local type.

export async function normalizeTelegram(update: any): Promise<InboundMessage | null> {
  const message =
    update?.message ?? update?.edited_message ?? update?.channel_post ?? update?.edited_channel_post;
  if (!message) return null;

  const chatId = message?.chat?.id;
  const senderId = message?.from?.id ?? message?.sender_chat?.id;
  if (!chatId || !senderId) return null;

  const threadId: number | undefined =
    typeof message?.message_thread_id === "number" ? message.message_thread_id : undefined;

  const sessionId = threadId ? `telegram:${chatId}:${threadId}` : `telegram:${chatId}`;

  // TEXT
  if (typeof message?.text === "string" && message.text.trim()) {
    return {
      channel: "telegram",
      sessionId,
      senderId: String(senderId),
      senderUsername: message?.from?.username ? String(message.from.username) : undefined,
      text: message.text,
      ts: Date.now(),
      raw: update,
    } as any;
  }

  // PHOTO (message.photo[]) — pick largest
  if (Array.isArray(message?.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    const fileId = largest?.file_id;
    if (!fileId) return null;

    const { base64, mimeType } = await telegramFileIdToBase64(fileId);

    return {
      channel: "telegram",
      sessionId,
      senderId: String(senderId),
      senderUsername: message?.from?.username ? String(message.from.username) : undefined,
      text: typeof message?.caption === "string" ? message.caption : "",
      ts: Date.now(),
      raw: update,

      // These fields are what your session workflow extractor already looks for:
      image_base64: base64,
      image_mime_type: mimeType,
    } as any;
  }

  // DOCUMENT that is an image (png/jpg/webp sent as a file)
  const doc = message?.document;
  if (doc?.file_id) {
    const mime: string = doc?.mime_type ?? "";
    if (typeof mime === "string" && mime.startsWith("image/")) {
      const { base64, mimeType } = await telegramFileIdToBase64(doc.file_id);

      return {
        channel: "telegram",
        sessionId,
        senderId: String(senderId),
        senderUsername: message?.from?.username ? String(message.from.username) : undefined,
        text: typeof message?.caption === "string" ? message.caption : "",
        ts: Date.now(),
        raw: update,
        image_base64: base64,
        image_mime_type: mimeType,
      } as any;
    }
  }

  // ignore stickers/voice/etc for now
  return null;
}


export function normalizeWhatsApp(body: any): InboundMessage[] {
  // WhatsApp Cloud API webhook payload structure: entry[].changes[].value.messages[]
  const out: InboundMessage[] = [];
  const entries = body?.entry ?? [];
  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      const value = change?.value;
      const messages = value?.messages ?? [];
      for (const m of messages) {
        // Only handle text for now
        const fromRaw = String(m.from ?? "");
        const from = fromRaw.startsWith("+") ? fromRaw : `+${fromRaw}`;
        const text = m?.text?.body;
        if (!from || !text) continue;

        out.push({
          channel: "whatsapp",
          sessionId: `whatsapp:${from}`,
          senderId: from,
          text: String(text),
          ts: Date.now(),
          raw: m,
        });
      }
    }
  }
  return out;
}

export function parsePairCommand(text: string): { code?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/pair")) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return { code: parts[1] };
  return { code: undefined };
}
export function normalizeTextbeltReply(body: any): InboundMessage | null {
  // Textbelt reply webhook payload:
  // { textId, fromNumber, text, data? }
  const from = body?.fromNumber ? String(body.fromNumber) : "";
  const text = body?.text ? String(body.text) : "";
  if (!from || !text) return null;

  const fromE164 = from.startsWith("+") ? from : `+${from}`;

  return {
    channel: "sms",
    sessionId: `sms:${fromE164}`,
    senderId: fromE164,
    text,
    ts: Date.now(),
    raw: body,
  };
}

