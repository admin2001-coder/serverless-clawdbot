import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import {
  appendMemoryEvent,
  buildDurableMemoryContext,
  getSessionSummary,
  updateSessionSummary,
} from "@/app/lib/memory";

function textFromMessage(message: ModelMessage): string {
  const c: any = (message as any).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part?.text === "string") return part.text;
        if (part?.type) return `[${part.type}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(c ?? "");
}

export async function loadDurableMemoryContextStep(userId: string, sessionId: string): Promise<string> {
  "use step";
  return await buildDurableMemoryContext(userId, sessionId);
}

export async function recordTurnMemoryStep(args: {
  userId: string;
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  "use step";
  await appendMemoryEvent({
    userId: args.userId,
    sessionId: args.sessionId,
    role: "user",
    text: args.userText,
    source: "inbound",
    turnId: args.turnId,
  });
  await appendMemoryEvent({
    userId: args.userId,
    sessionId: args.sessionId,
    role: "assistant",
    text: args.assistantText,
    source: "assistant",
    turnId: args.turnId,
  });
}

export async function maybeSummarizeHistoryStep(args: {
  userId: string;
  sessionId: string;
  history: ModelMessage[];
}): Promise<void> {
  "use step";

  const every = Number(process.env.MEMORY_SUMMARIZE_AFTER_MESSAGES ?? 24);
  if (!Number.isFinite(every) || every <= 0 || args.history.length < every) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const existing = await getSessionSummary(args.sessionId);
  const modelName = process.env.MEMORY_MODEL_NAME ?? process.env.FAST_MODEL_NAME ?? process.env.MODEL_NAME ?? "gpt-4o-mini";
  const transcript = args.history
    .slice(-Math.min(args.history.length, 36))
    .map((m) => `${m.role}: ${textFromMessage(m)}`)
    .join("\n\n");

  try {
    const result = await generateText({
      model: openai(modelName),
      prompt: [
        "Update a durable chat memory summary. Preserve concrete user preferences, decisions, unfinished tasks, names, resources, and constraints.",
        "Do not include generic small talk. Keep it compact and useful for future turns.",
        "",
        "Existing summary:",
        existing || "(none)",
        "",
        "Recent transcript:",
        transcript,
      ].join("\n"),
      temperature: 0,
    } as any);

    const summary = String(result.text ?? "").trim();
    if (summary) await updateSessionSummary(args.sessionId, summary);
  } catch {
    // Memory summarization must never block the user-facing turn.
  }
}
