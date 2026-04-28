// app/workflows/session.ts
import { sleep } from "workflow";
import type { ModelMessage } from "ai";
import type { InboundMessage } from "@/app/lib/normalize";
import type { QueuedInboundMessage, LogicalUserInput } from "@/app/lib/inboundQueue";

import { agentTurn } from "@/app/steps/agentTurn";
import { sendOutbound } from "@/app/steps/sendOutbound";
import { loadHistoryStep, saveHistoryStep } from "@/app/steps/sessionStateSteps";
import {
  acquireSessionProcessorStep,
  claimPendingInboundMessagesStep,
  coalesceInboundMessagesStep,
  completeInboundMessagesStep,
  getSessionQueuePollMsStep,
  getPendingSessionSnapshotStep,
  markSessionQueueIdleStep,
  requeueInboundMessagesStep,
  releaseSessionProcessorStep,
  renewSessionProcessorStep,
} from "@/app/steps/inboundSteps";
import {
  loadDurableMemoryContextStep,
  maybeSummarizeHistoryStep,
  recordTurnMemoryStep,
} from "@/app/steps/memorySteps";

// -----------------------------
// Helpers: multimodal user msg
// -----------------------------
type ImageInput =
  | { kind: "url"; value: string }
  | { kind: "base64"; value: string };

function extractImages(msg: InboundMessage): ImageInput[] {
  const m: any = msg as any;
  const out: ImageInput[] = [];

  if (typeof m.imageUrl === "string" && m.imageUrl) out.push({ kind: "url", value: m.imageUrl });
  if (typeof m.image_url === "string" && m.image_url) out.push({ kind: "url", value: m.image_url });

  if (Array.isArray(m.imageUrls)) for (const u of m.imageUrls) if (typeof u === "string" && u) out.push({ kind: "url", value: u });
  if (Array.isArray(m.image_urls)) for (const u of m.image_urls) if (typeof u === "string" && u) out.push({ kind: "url", value: u });

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

  if (typeof m.imageBase64 === "string" && m.imageBase64) out.push({ kind: "base64", value: m.imageBase64 });
  if (typeof m.image_base64 === "string" && m.image_base64) out.push({ kind: "base64", value: m.image_base64 });

  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.kind}:${x.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildUserModelMessage(input: LogicalUserInput, sourceMessages: QueuedInboundMessage[]): ModelMessage {
  const images = sourceMessages.flatMap((msg) => extractImages(msg));
  const uniqueImages: ImageInput[] = [];
  const seen = new Set<string>();
  for (const image of images) {
    const key = `${image.kind}:${image.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueImages.push(image);
  }

  if (!uniqueImages.length) {
    return { role: "user", content: input.text ?? "" };
  }

  const parts: any[] = [];
  if (input.text && input.text.trim()) parts.push({ type: "text", text: input.text });

  for (const img of uniqueImages) {
    if (img.kind === "url") parts.push({ type: "image", image: new URL(img.value) });
    else parts.push({ type: "image", image: img.value });
  }

  return { role: "user", content: parts } as any;
}

function trimHistory(history: ModelMessage[], maxMessages: number): ModelMessage[] {
  const m = Math.max(8, Math.min(300, maxMessages));
  return history.length <= m ? history : history.slice(history.length - m);
}


function tinyStableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildWorkflowTurnId(sessionId: string, input: LogicalUserInput): string {
  return tinyStableHash(`${sessionId}|${input.sourceInboundIds.join(",")}|${input.text}`);
}

function textForMemory(input: LogicalUserInput): string {
  return input.text?.trim() || "[non-text message]";
}

function groupById(messages: QueuedInboundMessage[]): Map<string, QueuedInboundMessage> {
  const map = new Map<string, QueuedInboundMessage>();
  for (const msg of messages) map.set(msg.inboundId, msg);
  return map;
}

function firstSourceMessage(input: LogicalUserInput, byId: Map<string, QueuedInboundMessage>): QueuedInboundMessage | null {
  for (const id of input.sourceInboundIds) {
    const msg = byId.get(id);
    if (msg) return msg;
  }
  return null;
}

async function processLogicalInput(args: {
  sessionId: string;
  input: LogicalUserInput;
  sourceMessages: QueuedInboundMessage[];
  history: ModelMessage[];
}): Promise<ModelMessage[]> {
  const first = args.sourceMessages[0];
  if (!first) return args.history;

  const userId = `${first.channel}:${first.senderId}`;
  const turnId = buildWorkflowTurnId(args.sessionId, args.input);
  const durableMemory = await loadDurableMemoryContextStep(userId, args.sessionId);

  let history = trimHistory(args.history, 60);
  history.push(buildUserModelMessage(args.input, args.sourceMessages));

  const result = await agentTurn({
    sessionId: args.sessionId,
    userId,
    channel: first.channel,
    history,
    showTyping: first.channel === "telegram",
    turnId,
    durableMemory,
    deliveryIdempotencyKey: `turn:${turnId}:final`,
  });

  const text = String(result.text ?? "").trim();
  history.push({ role: "assistant", content: text });

  // Send before memory/summarization work. Telegram streaming usually already
  // delivered inside agentTurn; non-streaming channels should not wait on Redis
  // memory writes or model summarization before the user sees the answer.
  if (!(result as any).delivered) {
    await sendOutbound({
      channel: first.channel,
      sessionId: first.sessionId,
      text,
      idempotencyKey: `turn:${turnId}:final`,
    });
  }

  await saveHistoryStep(args.sessionId, history);
  await recordTurnMemoryStep({
    userId,
    sessionId: args.sessionId,
    turnId,
    userText: textForMemory(args.input),
    assistantText: text,
  });
  await maybeSummarizeHistoryStep({ userId, sessionId: args.sessionId, history });

  return history;
}

// -----------------------------
// The workflow (NO HOOKS)
// -----------------------------
export async function sessionWorkflow(sessionId: string) {
  "use workflow";

  const claim = await acquireSessionProcessorStep(sessionId);
  if (!claim.acquired) return { ok: true, skipped: "processor_already_running" };

  let processed = 0;
  const queuePollMs = await getSessionQueuePollMsStep();

  try {
    while (true) {
      await renewSessionProcessorStep(sessionId, claim.token);

      const messages = await claimPendingInboundMessagesStep(sessionId);
      if (!messages.length) {
        const pending = await getPendingSessionSnapshotStep(sessionId);
        if (pending.pending > 0) {
          const waitMs = Math.max(100, Math.min(2000, pending.waitMs || queuePollMs));
          await sleep(`${waitMs}ms`);
          continue;
        }

        await markSessionQueueIdleStep(sessionId);
        return { ok: true, processed };
      }

      try {
        const byId = groupById(messages);
        const logicalInputs = await coalesceInboundMessagesStep(messages);
        let history = await loadHistoryStep(sessionId);
        history = Array.isArray(history) ? history : [];

        for (const input of logicalInputs) {
          await renewSessionProcessorStep(sessionId, claim.token);
          const sourceMessages = input.sourceInboundIds.map((id) => byId.get(id)).filter(Boolean) as QueuedInboundMessage[];
          const first = firstSourceMessage(input, byId);
          if (!first || !sourceMessages.length) continue;
          history = await processLogicalInput({ sessionId, input, sourceMessages, history });
          await renewSessionProcessorStep(sessionId, claim.token);
          processed += sourceMessages.length;
        }

        await completeInboundMessagesStep(messages.map((msg) => msg.inboundId));
      } catch (error) {
        await requeueInboundMessagesStep(messages);
        throw error;
      }
    }
  } finally {
    await releaseSessionProcessorStep(sessionId, claim.token);
  }
}
