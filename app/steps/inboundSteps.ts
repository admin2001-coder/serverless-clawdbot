import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { QueuedInboundMessage, LogicalUserInput } from "@/app/lib/inboundQueue";
import {
  acquireSessionProcessor,
  claimPendingInboundMessages,
  completeInboundMessages,
  fallbackCoalesceMessages,
  inboundBatchDebug,
  markSessionQueueIdle,
  getPendingSessionSnapshot,
  recoverStaleInboundMessages,
  requeueInboundMessages,
  releaseSessionProcessor,
  renewSessionProcessor,
} from "@/app/lib/inboundQueue";

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function tryParseJsonObject(text: string): any | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }

  return null;
}

function normalizeLogicalInputs(value: any, fallback: LogicalUserInput[]): LogicalUserInput[] {
  const arr = Array.isArray(value?.items) ? value.items : [];
  const out: LogicalUserInput[] = [];
  const expected = fallback.flatMap((item) => item.sourceInboundIds);
  const expectedSet = new Set(expected);
  const used = new Set<string>();

  for (const item of arr) {
    const text = String(item?.text ?? "").trim();
    const sourceInboundIds = Array.isArray(item?.sourceInboundIds)
      ? item.sourceInboundIds.map((x: any) => String(x)).filter((id: string) => expectedSet.has(id) && !used.has(id))
      : [];
    if (!text || !sourceInboundIds.length) continue;

    for (const id of sourceInboundIds) used.add(id);

    const relation = ["single", "joined_fragments", "separate_intent", "fallback"].includes(String(item?.relation))
      ? String(item.relation)
      : "separate_intent";
    const confidence = Number(item?.confidence);

    out.push({
      id: String(item?.id || `${sourceInboundIds.join("_")}`),
      text,
      sourceInboundIds,
      relation: relation as LogicalUserInput["relation"],
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
    });
  }

  if (!out.length) return fallback;
  if (used.size !== expectedSet.size) return fallback;
  return out;
}

export async function acquireSessionProcessorStep(sessionId: string) {
  "use step";
  return await acquireSessionProcessor(sessionId);
}

export async function releaseSessionProcessorStep(sessionId: string, token: string) {
  "use step";
  await releaseSessionProcessor(sessionId, token);
}

export async function renewSessionProcessorStep(sessionId: string, token: string): Promise<boolean> {
  "use step";
  return await renewSessionProcessor(sessionId, token);
}

export async function getPendingSessionSnapshotStep(sessionId: string) {
  "use step";
  return await getPendingSessionSnapshot(sessionId);
}

export async function getSessionQueuePollMsStep(): Promise<number> {
  "use step";
  const ms = parseIntOr(process.env.SESSION_QUEUE_POLL_MS, 250);
  return Math.max(100, Math.min(2000, ms));
}

export async function claimPendingInboundMessagesStep(sessionId: string): Promise<QueuedInboundMessage[]> {
  "use step";
  return await claimPendingInboundMessages(sessionId);
}

export async function completeInboundMessagesStep(ids: string[]): Promise<void> {
  "use step";
  await completeInboundMessages(ids);
}

export async function requeueInboundMessagesStep(messages: QueuedInboundMessage[]): Promise<void> {
  "use step";
  await requeueInboundMessages(messages);
}

export async function markSessionQueueIdleStep(sessionId: string): Promise<void> {
  "use step";
  await markSessionQueueIdle(sessionId);
}

export async function recoverStaleInboundMessagesStep() {
  "use step";
  return await recoverStaleInboundMessages();
}

export async function coalesceInboundMessagesStep(messages: QueuedInboundMessage[]): Promise<LogicalUserInput[]> {
  "use step";

  const fallback = fallbackCoalesceMessages(messages);
  if (messages.length <= 1) return fallback;

  const useModel = (process.env.INTAKE_USE_MODEL ?? "false") === "true";
  if (!useModel) return fallback;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;

  const modelName =
    process.env.INTAKE_MODEL_NAME ??
    process.env.FAST_MODEL_NAME ??
    process.env.MODEL_NAME ??
    "gpt-4o-mini";

  const prompt = [
    "You are an intake coordinator for a chat assistant.",
    "Decide whether several provider-delivered messages are fragments of one user message or separate user intents.",
    "Use timing, message order, wording continuity, attachments/captions, and whether the later text completes the earlier text.",
    "Do not classify by fixed keywords. Read the actual content.",
    "Return only compact JSON with this shape:",
    "{\"items\":[{\"text\":\"merged or original text\",\"sourceInboundIds\":[\"id\"],\"relation\":\"single|joined_fragments|separate_intent\",\"confidence\":0.0}]}",
    "Every sourceInboundId must appear exactly once across all items, in original order. Preserve user wording; only join fragments with newlines when they are one message.",
    "",
    inboundBatchDebug(messages),
  ].join("\n");

  try {
    const result = await generateText({
      model: openai(modelName),
      prompt,
      temperature: 0,
    } as any);
    return normalizeLogicalInputs(tryParseJsonObject(result.text), fallback);
  } catch {
    return fallback;
  }
}

export function getCoalesceSleepMs(): number {
  const ms = parseIntOr(process.env.MESSAGE_COHERENCE_WINDOW_MS, 700);
  return Math.max(150, Math.min(15_000, ms));
}
