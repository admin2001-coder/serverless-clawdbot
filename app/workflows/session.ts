// app/workflows/session.ts
import { defineHook } from "workflow";
import type { InboundMessage } from "@/app/lib/normalize";
import { agentTurn } from "@/app/steps/agentTurn";
import { sendOutbound } from "@/app/steps/sendOutbound";
import { loadHistoryStep, saveHistoryStep } from "@/app/steps/sessionStateSteps";
import type { ModelMessage } from "ai";

export const inboundHook = defineHook<InboundMessage>();

type ImageInput =
  | { kind: "url"; value: string }
  | { kind: "base64"; value: string };

// Try to extract images from many possible InboundMessage shapes without hard-coding your schema.
// This compiles cleanly (no `never[]` concat typing issue).
function extractImages(msg: InboundMessage): ImageInput[] {
  const m: any = msg as any;
  const out: ImageInput[] = [];

  // 1) Direct single fields
  if (typeof m.imageUrl === "string" && m.imageUrl) out.push({ kind: "url", value: m.imageUrl });
  if (typeof m.image_url === "string" && m.image_url) out.push({ kind: "url", value: m.image_url });

  // 2) Arrays of urls
  if (Array.isArray(m.imageUrls)) {
    for (const u of m.imageUrls) if (typeof u === "string" && u) out.push({ kind: "url", value: u });
  }
  if (Array.isArray(m.image_urls)) {
    for (const u of m.image_urls) if (typeof u === "string" && u) out.push({ kind: "url", value: u });
  }

  // 3) Attachments/media/files arrays
  const arrays: any[][] = [];
  if (Array.isArray(m.attachments)) arrays.push(m.attachments);
  if (Array.isArray(m.media)) arrays.push(m.media);
  if (Array.isArray(m.files)) arrays.push(m.files);

  for (const arr of arrays) {
    for (const a of arr) {
      if (!a) continue;

      const url =
        (typeof a.url === "string" && a.url) ||
        (typeof a.href === "string" && a.href) ||
        (typeof a.downloadUrl === "string" && a.downloadUrl) ||
        (typeof a.download_url === "string" && a.download_url) ||
        (typeof a.publicUrl === "string" && a.publicUrl) ||
        (typeof a.public_url === "string" && a.public_url) ||
        "";

      const mime =
        (typeof a.mimeType === "string" && a.mimeType) ||
        (typeof a.mime_type === "string" && a.mime_type) ||
        (typeof a.contentType === "string" && a.contentType) ||
        (typeof a.content_type === "string" && a.content_type) ||
        "";

      const isImageByMime = typeof mime === "string" && mime.startsWith("image/");
      const isImageByExt = typeof url === "string" && /\.(png|jpe?g|webp|gif|bmp|tiff?)($|\?)/i.test(url);

      if (url && (isImageByMime || isImageByExt)) out.push({ kind: "url", value: url });

      const b64 =
        (typeof a.base64 === "string" && a.base64) ||
        (typeof a.data === "string" && a.data) ||
        (typeof a.b64 === "string" && a.b64) ||
        "";

      if (b64 && (isImageByMime || b64.length > 200)) out.push({ kind: "base64", value: b64 });
    }
  }

  // 4) Raw base64 fields
  if (typeof m.imageBase64 === "string" && m.imageBase64) out.push({ kind: "base64", value: m.imageBase64 });
  if (typeof m.image_base64 === "string" && m.image_base64) out.push({ kind: "base64", value: m.image_base64 });

  // De-dupe
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.kind}:${x.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildUserModelMessage(msg: InboundMessage): ModelMessage {
  const images = extractImages(msg);

  // No images: keep it simple
  if (!images.length) {
    return { role: "user", content: msg.text ?? "" };
  }

  // With images: use multimodal parts
  const parts: any[] = [];
  if (msg.text && msg.text.trim()) parts.push({ type: "text", text: msg.text });

  for (const img of images) {
    if (img.kind === "url") {
      // URL must be fetchable by the model (public or signed/proxied).
      parts.push({ type: "image", image: new URL(img.value) });
    } else {
      // base64 string (AI SDK accepts directly)
      parts.push({ type: "image", image: img.value });
    }
  }

  return { role: "user", content: parts } as any;
}

export async function sessionWorkflow(sessionId: string, first?: InboundMessage) {
  "use workflow";

  let history = (await loadHistoryStep(sessionId)) as ModelMessage[];

  async function handle(msg: InboundMessage) {
    // ✅ Push multimodal user message when images exist
    history.push(buildUserModelMessage(msg));

    const result = await agentTurn({
      sessionId,
      userId: `${msg.channel}:${msg.senderId}`,
      channel: msg.channel,
      history,
    });
// ✅ if Telegram streaming delivered, skip sendOutbound
if (!(result as any).delivered) {
  await sendOutbound({
    channel: msg.channel,
    sessionId: msg.sessionId,
    text: result.text,
  });
}
    history.push({ role: "assistant", content: result.text });

    await sendOutbound({
      channel: msg.channel,
      sessionId: msg.sessionId,
      text: result.text,
    });

    await saveHistoryStep(sessionId, history);
  }

  if (first) await handle(first);

  const hook = inboundHook.create({ token: `sess:${sessionId}` });
  for await (const msg of hook) {
    await handle(msg);
  }
}
