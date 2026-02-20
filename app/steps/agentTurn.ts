import { generateText, stepCountIs, tool, type ToolSet, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { z } from "zod";

import { env, csvEnv } from "@/app/lib/env";
import type { Channel } from "@/app/lib/identity";
import { createSendTask } from "@/app/lib/tasks";
import { sshExec } from "@/app/steps/sshExec";

const composio = new Composio({ provider: new VercelProvider() });

function filterTools(tools: ToolSet, allow: string[]): ToolSet {
  if (!allow.length) return tools;
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    if (allow.includes(name)) out[name] = def;
  }
  return out as ToolSet;
}
// --- Telegram streaming + typing (drop-in) ---

const telegramStreamingEnabled =
  args.channel === "telegram" &&
  (args.showTyping ?? true) &&
  (env("TELEGRAM_STREAMING") ?? "true") !== "false";

const editThrottleMs = Math.max(250, Number(env("TELEGRAM_STREAM_EDIT_THROTTLE_MS") ?? 750));
const typingIntervalMs = Math.max(1000, Number(env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
const maxEditChars = Math.max(800, Math.min(3800, Number(env("TELEGRAM_STREAM_CHUNK_CHARS") ?? 3500)));

let typingLoop: { stop: () => void } | null = null;
let placeholderMsgId: number | null = null;

function createEditCoalescer() {
  let lastSent = "";
  let lastAt = 0;
  let inflight: Promise<void> | null = null;
  let pending: string | null = null;

  async function doEdit(text: string) {
    const t = clampNonEmptyText(text);
    if (t === lastSent) return;

    const now = Date.now();
    const wait = editThrottleMs - (now - lastAt);
    if (wait > 0) await sleep(wait);

    try {
      await telegramEditMessageText(args.sessionId, placeholderMsgId!, t);
      lastSent = t;
      lastAt = Date.now();
    } catch {
      // best-effort (rate limits / "message not modified")
    }
  }

  async function worker() {
    while (pending !== null) {
      const t = pending;
      pending = null;
      await doEdit(t);
    }
    inflight = null;
  }

  return {
    request(text: string) {
      pending = text;
      if (!inflight) inflight = worker();
    },
    async flush() {
      if (inflight) await inflight;
      if (pending !== null) {
        const t = pending;
        pending = null;
        await doEdit(t);
      }
    },
  };
}

async function deliverFinalTelegram(text: string) {
  const chunks = splitForTelegram(text, maxEditChars);

  // Edit placeholder to first chunk
  if (placeholderMsgId != null) {
    try {
      await telegramEditMessageText(args.sessionId, placeholderMsgId, chunks[0]);
    } catch {
      placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
    }
  } else {
    placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
  }

  // Send remaining chunks once (only at the end)
  for (let i = 1; i < chunks.length; i++) {
    await telegramSendMessage(args.sessionId, chunks[i], { disableNotification: true });
  }

  return { delivered: true };
}

async function streamToTelegram(textStream: AsyncIterable<string>): Promise<string> {
  let full = "";
  const editor = createEditCoalescer();

  for await (const delta of textStream) {
    full += delta;
    // only edit the preview window while streaming (prevents message spam)
    editor.request(full.slice(0, maxEditChars));
  }

  await editor.flush();
  return full;
}

// --- In your main try/finally around generation ---
try {
  if (telegramStreamingEnabled) {
    // start typing loop (non-blocking)
    typingLoop = telegramStartChatActionLoop(args.sessionId, "typing", { intervalMs: typingIntervalMs });

    // send placeholder immediately
    placeholderMsgId = await telegramSendMessage(args.sessionId, "…", { disableNotification: true });

    // run model with streamText and progressively edit
    const s = streamText({
      model: openai(modelName),
      system,
      messages,
      tools,
      temperature,
      stopWhen: stepCountIs(10),
    });

    const text = await streamToTelegram(s.textStream);

    // finalize message (and split if long)
    await deliverFinalTelegram(text);

    return { text, responseMessages: [], delivered: true };
  }

  // non-telegram or streaming disabled -> normal generateText
  const r = await generateText({ model: openai(modelName), system, messages, tools, temperature, stopWhen: stepCountIs(10) });
  return { text: r.text, responseMessages: r.response?.messages as any };

} finally {
  typingLoop?.stop();
}
export async function agentTurn(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  history: ModelMessage[];
}) {
  "use step";

  const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";
  const modelName = env("MODEL_NAME") ?? "gpt-4o-mini";

  const scheduleMessageInput = z.object({
    delaySeconds: z.number().min(1).max(60 * 60 * 24 * 14).describe("Seconds from now to send the message."),
    text: z.string().min(1).max(2000).describe("Message text to send at that time."),
  });

  const scheduleMessage = tool({
    description:
      "Schedule a message to be sent back to the same user/session in the future (for reminders, follow-ups, periodic check-ins).",
    inputSchema: scheduleMessageInput,
    execute: async ({ delaySeconds, text }: z.infer<typeof scheduleMessageInput>) => {
      const dueAt = Date.now() + Math.floor(delaySeconds * 1000);
      const id = await createSendTask({
        type: "send",
        dueAt,
        channel: args.channel,
        sessionId: args.sessionId,
        text,
        createdBy: "agent",
      } as any);
      return { ok: true, taskId: id, dueAt };
    },
  });

  const sshToolInput = z.object({
    command: z.string().min(1).max(500),
  });

  const sshTool = tool({
    description:
      "Run a SAFE allowlisted command over SSH on a configured host. Commands are restricted by SSH_ALLOWED_PREFIXES.",
    inputSchema: sshToolInput,
    execute: async ({ command }: z.infer<typeof sshToolInput>) => {
      const output = await sshExec(command);
      return { ok: true, output };
    },
  });

  let composioTools: ToolSet = {};
  if (env("COMPOSIO_API_KEY")) {
    const userScoped = await composio.create(args.userId);
    const tools = (await userScoped.tools()) as ToolSet;
    composioTools = filterTools(tools, csvEnv("COMPOSIO_ALLOWED_TOOLS"));
  }

  const tools: ToolSet = {
    ...composioTools,
    schedule_message: scheduleMessage,
  };

  if (env("SSH_HOST") && env("SSH_USER") && env("SSH_PRIVATE_KEY_B64")) {
    (tools as any).ssh_exec = sshTool;
  }

  const system = [
    "You are an autonomous assistant running inside a messaging bot connected to composio api and its tools",
    "You can use tools to take actions and schedule future follow-ups.",
    "",
    "Safety & intent:",
    "- If AUTONOMOUS_MODE=assistive: avoid destructive actions (sending emails, deleting files, changing calendars, etc.) unless the user explicitly requested it.",
    "- If AUTONOMOUS_MODE=full: you may act more proactively, but still avoid irreversible or high-risk actions unless clearly justified.",
    "",
    `Current mode: full`,
    "",
    "Conversation style:",
    "- Be concise on SMS; slightly richer on Telegram/WhatsApp.",
    "- Confirm assumptions when it matters; otherwise make reasonable defaults.",
    "",
    "Scheduling:",
    "- Use schedule_message to remind the user later or to follow up.",
  ].join("\n");

  const result = await generateText({
    model: openai(modelName),
    system,
    messages: args.history,
    tools,
    stopWhen: stepCountIs(5),
  });

  return { text: result.text, responseMessages: result.response.messages };
}
