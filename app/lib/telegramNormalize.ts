// app/lib/telegramNormalize.ts
import type { InboundMessage } from "@/app/lib/normalize";
import { telegramFileIdToBase64 } from "@/app/lib/telegramMedia";

type TelegramUpdate = any;

function sessionIdFromChatAndThread(chatId: string | number, threadId?: number): string {
  return threadId ? `telegram:${chatId}:${threadId}` : `telegram:${chatId}`;
}

export async function telegramUpdateToInbound(update: TelegramUpdate): Promise<InboundMessage | null> {
  const message = update?.message ?? update?.edited_message ?? update?.channel_post ?? update?.edited_channel_post;
  if (!message) return null;

  const chatId = message?.chat?.id;
  const senderId = message?.from?.id ?? message?.sender_chat?.id;
  if (!chatId || !senderId) return null;

  const threadId: number | undefined = typeof message?.message_thread_id === "number" ? message.message_thread_id : undefined;

  const base: any = {
    channel: "telegram",
    sessionId: sessionIdFromChatAndThread(chatId, threadId),
    senderId: String(senderId),
    text: "",
  };

  // 1) Text message
  if (typeof message?.text === "string" && message.text.trim()) {
    base.text = message.text;
    return base as InboundMessage;
  }

  // 2) Photo message (pick largest photo)
  if (Array.isArray(message?.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    const fileId = largest?.file_id;
    if (!fileId) return null;

    const { base64, mimeType } = await telegramFileIdToBase64(fileId);

    base.text = typeof message?.caption === "string" ? message.caption : "";
    base.image_base64 = base64;
    base.image_mime_type = mimeType;

    return base as InboundMessage;
  }

  // 3) Document that is actually an image (people send PNG/JPG as “file”)
  const doc = message?.document;
  if (doc?.file_id) {
    const mime: string = doc?.mime_type ?? "";
    const isImage = typeof mime === "string" && mime.startsWith("image/");
    if (isImage) {
      const { base64, mimeType } = await telegramFileIdToBase64(doc.file_id);

      base.text = typeof message?.caption === "string" ? message.caption : "";
      base.image_base64 = base64;
      base.image_mime_type = mimeType;

      return base as InboundMessage;
    }
  }

  // Ignore stickers/voice/etc for now
  return null;
}
