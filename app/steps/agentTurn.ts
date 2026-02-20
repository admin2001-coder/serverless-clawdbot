/*
import {
  generateText,
  streamText,
  stepCountIs,
  tool,
  zodSchema,
  type ToolSet,
  type ModelMessage,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { z } from "zod/v4";

import { env, csvEnv } from "@/app/lib/env";
import type { Channel } from "@/app/lib/identity";
import { createSendTask } from "@/app/lib/tasks";
import { sshExec } from "@/app/steps/sshExec";

import {
  telegramSendMessage,
  telegramEditMessageText,
  telegramStartChatActionLoop,
} from "@/app/lib/providers/telegram";

// ============================================================
// Composio client
// ============================================================
const composio = new Composio({
  apiKey: env("COMPOSIO_API_KEY") || "",
  provider: new VercelProvider(),
});

const composioToolsCache = new Map<string, { tools: ToolSet; expiresAt: number }>();

// ============================================================
// Small helpers
// ============================================================
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonEmptyText(text: string): string {
  const t = String(text ?? "").trimEnd();
  return t.length ? t : "…";
}

function normalizeHistory(history: ModelMessage[]): ModelMessage[] {
  return (history ?? []).map((m) => {
    const c: any = (m as any).content;
    if (typeof c === "string") return { ...m, content: [{ type: "text" as const, text: c }] } as any;
    return m;
  });
}

function extractRecentUserText(history: ModelMessage[]): string {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const c: any = (lastUser as any).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.find((p) => p?.type === "text")?.text;
    if (typeof t === "string") return t;
  }
  return "";
}

function historyHasImages(history: ModelMessage[]): boolean {
  for (const msg of history) {
    const c: any = (msg as any).content;
    if (!Array.isArray(c)) continue;
    if (c.some((p) => p?.type === "image")) return true;
  }
  return false;
}

function splitForTelegram(text: string, maxChars: number): string[] {
  const t = String(text ?? "");
  const max = Math.max(500, Math.min(4096, Math.floor(maxChars)));
  const out: string[] = [];
  let i = 0;

  while (i < t.length) {
    let end = Math.min(t.length, i + max);

    if (end < t.length) {
      const windowStart = Math.max(i, end - 250);
      const window = t.slice(windowStart, end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const cut = Math.max(nl, sp);
      if (cut > 0) end = windowStart + cut;
    }

    if (end <= i) end = Math.min(t.length, i + max);

    const chunk = t.slice(i, end).trim();
    if (chunk) out.push(chunk);
    i = end;
  }

  return out.length ? out : ["…"];
}

function parseSlashCommand(text: string): { cmd: string; arg: string } | null {
  const t = (text ?? "").trim();
  if (!t.startsWith("/")) return null;
  const [cmd, ...rest] = t.split(/\s+/);
  return { cmd: cmd.toLowerCase(), arg: rest.join(" ").trim() };
}

// ============================================================
// Composio allowlist handling ("*" means ALL)
// ============================================================
function filterComposioTools(tools: ToolSet): ToolSet {
  const allow = csvEnv("COMPOSIO_ALLOWED_TOOLS");
  if (!allow.length || allow.includes("*")) return tools;

  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    if (allow.includes(name)) out[name] = def;
  }
  return out as ToolSet;
}

async function getComposioToolsForUser(userId: string): Promise<ToolSet> {
  if (!env("COMPOSIO_API_KEY")) return {};

  const ttlMs = Math.max(0, parseIntOr(env("COMPOSIO_TOOLS_CACHE_TTL_MS"), 5 * 60_000));
  const now = Date.now();

  if (ttlMs > 0) {
    const cached = composioToolsCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.tools;
  }

  const userScoped = await composio.create(userId, { manageConnections: false } as any);
  const tools = (await userScoped.tools()) as ToolSet;
  const filtered = filterComposioTools(tools);

  if (ttlMs > 0) composioToolsCache.set(userId, { tools: filtered, expiresAt: now + ttlMs });
  return filtered;
}

async function composioListConnections(userId: string) {
  const userScoped = await composio.create(userId, { manageConnections: false } as any);
  const toolkits: any = await userScoped.toolkits();
  const items: any[] = toolkits?.items ?? [];

  const normalized = items
    .map((t) => ({
      slug: String(t?.slug ?? t?.name ?? "").toLowerCase(),
      name: String(t?.name ?? t?.slug ?? "").toLowerCase(),
      connected: Boolean(t?.connection?.connectedAccount?.id),
    }))
    .filter((x) => x.slug);

  return {
    ok: true,
    items: normalized.map((x) => ({ slug: x.slug, connected: x.connected })),
    connected: normalized.filter((x) => x.connected).map((x) => x.slug),
  };
}

async function composioConnectToolkitByName(userId: string, toolkitInput: string) {
  const wanted = toolkitInput.trim().toLowerCase();
  const wantedNorm = wanted.replace(/\s+/g, "");

  const alias = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t === "x") return "twitter";
    if (t === "twitter/x") return "twitter";
    if (t === "docs") return "google docs";
    if (t === "drive") return "google drive";
    if (t === "sheets") return "google sheets";
    return t;
  };

  const w = alias(wanted);
  const wNorm = alias(wantedNorm);

  const userScoped = await composio.create(userId, { manageConnections: false } as any);
  const toolkits: any = await userScoped.toolkits();
  const items: any[] = toolkits?.items ?? [];

  const normalized = items
    .map((t) => {
      const slug = String(t?.slug ?? t?.name ?? "").toLowerCase();
      const name = String(t?.name ?? t?.slug ?? "").toLowerCase();
      const slugNorm = slug.replace(/\s+/g, "");
      const nameNorm = name.replace(/\s+/g, "");
      const connected = Boolean(t?.connection?.connectedAccount?.id);
      return { slug, name, slugNorm, nameNorm, connected };
    })
    .filter((x) => x.slug);

  const match =
    normalized.find((x) => x.slug === w || x.name === w) ||
    normalized.find((x) => x.slugNorm === wNorm || x.nameNorm === wNorm) ||
    normalized.find((x) => x.slug.includes(w) || x.name.includes(w)) ||
    normalized.find((x) => x.slugNorm.includes(wNorm) || x.nameNorm.includes(wNorm));

  if (!match) {
    const top = normalized
      .slice(0, 30)
      .map((x) => `${x.slug}${x.connected ? " (connected)" : ""}`)
      .join(", ");
    return {
      ok: false,
      error: `Toolkit "${toolkitInput}" not found in Composio toolkits list.`,
      hint: `Try one of: ${top}`,
    };
  }

  const callbackUrl = env("COMPOSIO_CALLBACK_URL") || undefined;
  const req: any = await userScoped.authorize(match.slug, callbackUrl ? { callbackUrl } : undefined);
  const link = String(req?.redirectUrl ?? req?.redirect_url ?? "");

  return { ok: Boolean(link), toolkit: match.slug, link, alreadyConnected: match.connected };
}

// ============================================================
// Telegram streaming coalescer
// ============================================================
function createEditCoalescer(opts: { sessionId: string; messageId: number; throttleMs: number }) {
  let lastSent = "";
  let lastAt = 0;

  let inflight: Promise<void> | null = null;
  let pending: string | null = null;

  async function doEdit(text: string) {
    const t = clampNonEmptyText(text);
    if (t === lastSent) return;

    const now = Date.now();
    const wait = opts.throttleMs - (now - lastAt);
    if (wait > 0) await sleep(wait);

    try {
      await telegramEditMessageText(opts.sessionId, opts.messageId, t);
      lastSent = t;
      lastAt = Date.now();
    } catch {
      // best-effort
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

// ============================================================
// MAIN
// ============================================================
export async function agentTurn(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  history: ModelMessage[];
  showTyping?: boolean;
}) {
  "use step";

  const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";

  const messages = normalizeHistory(args.history);
  const userText = String(extractRecentUserText(messages) ?? "").trim();
  const hasImages = historyHasImages(messages);

  // ✅ Use safe model names unless you have custom ones configured
  const fastModel = env("FAST_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o-mini";
  const smartModel = env("SMART_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o";
  const modelName = hasImages ? smartModel : fastModel;

  // ✅ Low temp for tools / less hallucination
  const temperature = Number(env("MODEL_TEMPERATURE") ?? "0.2");

  // Telegram streaming + typing
  const isTelegram = args.channel === "telegram";
  const telegramStreamingEnabled =
    isTelegram &&
    (args.showTyping ?? true) &&
    (env("TELEGRAM_STREAMING") ?? "true") !== "false";

  const editThrottleMs = Math.max(250, Number(env("TELEGRAM_STREAM_EDIT_THROTTLE_MS") ?? 750));
  const typingIntervalMs = Math.max(1000, Number(env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
  const maxEditChars = Math.max(800, Math.min(3800, Number(env("TELEGRAM_STREAM_CHUNK_CHARS") ?? 3500)));

  let typingLoop: { stop: () => void } | null = null;
  let placeholderMsgId: number | null = null;

  // ============================================================
  // Tools
  // ============================================================
  const scheduleMessage = tool({
    description: "Schedule a message back to this user/session after delaySeconds.",
    inputSchema: zodSchema(
      z.object({
        delaySeconds: z.number().min(1).max(60 * 60 * 24 * 14),
        text: z.string().min(1).max(2000),
      })
    ),
    execute: async (input: { delaySeconds: number; text: string }) => {
      const dueAt = Date.now() + Math.floor(input.delaySeconds * 1000);
      const id = await createSendTask({
        type: "send",
        dueAt,
        channel: args.channel,
        sessionId: args.sessionId,
        text: input.text,
        createdBy: "agent",
      } as any);
      return { ok: true, taskId: id, dueAt };
    },
  });

  const allowModelSsh = (env("SSH_TOOL_AUTONOMOUS") ?? "false") === "true";
  const sshTool = tool({
    description: allowModelSsh
      ? "Run any SSH command on the host."
      : "Run SSH only if user explicitly asked; otherwise instruct /ssh <command>.",
    inputSchema: zodSchema(z.object({ command: z.string().min(1).max(2000) })),
    execute: async (input: { command: string }) => {
      if (!allowModelSsh) {
        const explicit = userText.startsWith("/ssh") || /\bssh\b|\brun this command\b/i.test(userText);
        if (!explicit) return { ok: false, blocked: true, message: "Use /ssh <command> to run SSH." };
      }
      const output = await sshExec(input.command);
      return { ok: true, output };
    },
  });

  const connectToolkit = tool({
    description:
      "Generate a Composio connect/authorize link for a toolkit. Accepts user-friendly names like 'Typeform', 'Google Drive', or 'X'. Resolves by listing available Composio toolkits and choosing the closest match slug.",
    inputSchema: zodSchema(z.object({ toolkit: z.string().min(1) })),
    execute: async (input: { toolkit: string }) => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioConnectToolkitByName(args.userId, input.toolkit);
    },
  });

  const listConnections = tool({
    description: "List which Composio toolkits are connected for this user.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioListConnections(args.userId);
    },
  });

  // ============================================================
  // Fast-path /ssh (instant, no model)
  // ============================================================
  const slash = parseSlashCommand(userText);
  if (slash?.cmd === "/ssh") {
    const cmd = slash.arg;
    const out = cmd ? await sshExec(cmd) : "Usage: /ssh <command>";
    return { text: String(out), responseMessages: [] as any[] };
  }

  // ============================================================
  // Load Composio tools (ALWAYS if COMPOSIO_API_KEY set)
  // ============================================================
  let composioTools: ToolSet = {};
  if (env("COMPOSIO_API_KEY")) {
    composioTools = await getComposioToolsForUser(args.userId).catch(() => ({} as ToolSet));
  }

  const tools: ToolSet = {
    ...composioTools,
    schedule_message: scheduleMessage,
    ssh_exec: sshTool,
    connect_toolkit: connectToolkit,
    list_connections: listConnections,
  };

  // ============================================================
  // Telegram streaming helpers
  // ============================================================
  async function deliverFinalTelegram(text: string) {
    const chunks = splitForTelegram(text, maxEditChars);

    if (placeholderMsgId != null) {
      try {
        await telegramEditMessageText(args.sessionId, placeholderMsgId, chunks[0]);
      } catch {
        placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
      }
    } else {
      placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
    }

    // send remainder only once at the end
    for (let i = 1; i < chunks.length; i++) {
      await telegramSendMessage(args.sessionId, chunks[i], { disableNotification: true });
    }

    return { delivered: true };
  }

  async function streamToTelegram(textStream: AsyncIterable<string>): Promise<string> {
    let full = "";
    const editor = createEditCoalescer({
      sessionId: args.sessionId,
      messageId: placeholderMsgId!,
      throttleMs: editThrottleMs,
    });

    for await (const delta of textStream) {
      full += delta;
      editor.request(full.slice(0, maxEditChars));
    }

    await editor.flush();
    return full;
  }

  // ============================================================
  // System prompt
  // ============================================================
  const system = [
    "You are Clawdbot, an assistant running inside Telegram/WhatsApp/SMS with Composio tools.",
    "",
    "CRITICAL TOOL RULES:",
    "- If the user asks you to do an external action (Typeform, Twitter/X, Discord, Slack, etc.), you MUST use the appropriate tool.",
    "- Never claim an action succeeded unless a tool call returned success.",
    "- If an action requires the user to connect a toolkit, call connect_toolkit and give the link.",
    "- If you're unsure what's connected, call list_connections.",
    "",
    "SSH:",
    "- You can run SSH via ssh_exec if needed. If blocked, tell the user to use /ssh <command>.",
    "",
    `Mode: ${autonomy}`,
    "Be concise and correct. Avoid hallucinations.",
  ].join("\n");

  // ============================================================
  // Run generation (Telegram streams + typing)
  // ============================================================
  try {
    if (telegramStreamingEnabled) {
      // start typing loop (non-blocking)
      typingLoop = telegramStartChatActionLoop(args.sessionId, "typing", { intervalMs: typingIntervalMs });

      // send placeholder immediately so user sees activity
      placeholderMsgId = await telegramSendMessage(args.sessionId, "…", { disableNotification: true });

      const s = streamText({
        model: openai(modelName),
        system,
        messages,
        tools,
        temperature,
        stopWhen: stepCountIs(10),
      });

      const text = await streamToTelegram(s.textStream);
      await deliverFinalTelegram(text);

      // IMPORTANT: delivered=true prevents sessionWorkflow from sending another copy
      return { text, responseMessages: [] as any[], delivered: true };
    }

    const r = await generateText({
      model: openai(modelName),
      system,
      messages,
      tools,
      temperature,
      stopWhen: stepCountIs(10),
    });

    return { text: r.text, responseMessages: (r.response?.messages as any[]) ?? [] };
  } finally {
    typingLoop?.stop();
  }
}
*/
// app/steps/agentTurn.ts
import {
  generateText,
  streamText,
  stepCountIs,
  tool,
  zodSchema,
  type ToolSet,
  type ModelMessage,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { z } from "zod/v4";

import { env, csvEnv } from "@/app/lib/env";
import type { Channel } from "@/app/lib/identity";
import { createSendTask } from "@/app/lib/tasks";
import { sshExec } from "@/app/steps/sshExec";

import {
  telegramSendMessage,
  telegramEditMessageText,
  telegramStartChatActionLoop,
} from "@/app/lib/providers/telegram";

// ============================================================
// Composio client
// ============================================================
const composio = new Composio({
  apiKey: env("COMPOSIO_API_KEY") || "",
  provider: new VercelProvider(),
});

const composioToolsCache = new Map<string, { tools: ToolSet; expiresAt: number }>();

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonEmptyText(text: string): string {
  const t = String(text ?? "").trimEnd();
  return t.length ? t : "…";
}

function normalizeHistory(history: ModelMessage[]): ModelMessage[] {
  return (history ?? []).map((m) => {
    const c: any = (m as any).content;
    if (typeof c === "string") return { ...m, content: [{ type: "text" as const, text: c }] } as any;
    return m;
  });
}

function extractRecentUserText(history: ModelMessage[]): string {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const c: any = (lastUser as any).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.find((p) => p?.type === "text")?.text;
    if (typeof t === "string") return t;
  }
  return "";
}

function historyHasImages(history: ModelMessage[]): boolean {
  for (const msg of history) {
    const c: any = (msg as any).content;
    if (!Array.isArray(c)) continue;
    if (c.some((p) => p?.type === "image")) return true;
  }
  return false;
}

function splitForTelegram(text: string, maxChars: number): string[] {
  const t = String(text ?? "");
  const max = Math.max(500, Math.min(4096, Math.floor(maxChars)));
  const out: string[] = [];
  let i = 0;

  while (i < t.length) {
    let end = Math.min(t.length, i + max);

    if (end < t.length) {
      const windowStart = Math.max(i, end - 250);
      const window = t.slice(windowStart, end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const cut = Math.max(nl, sp);
      if (cut > 0) end = windowStart + cut;
    }

    if (end <= i) end = Math.min(t.length, i + max);

    const chunk = t.slice(i, end).trim();
    if (chunk) out.push(chunk);
    i = end;
  }

  return out.length ? out : ["…"];
}

function parseSlashCommand(text: string): { cmd: string; arg: string } | null {
  const t = (text ?? "").trim();
  if (!t.startsWith("/")) return null;
  const [cmd, ...rest] = t.split(/\s+/);
  return { cmd: cmd.toLowerCase(), arg: rest.join(" ").trim() };
}

// ============================================================
// Composio tool filtering (IMPORTANT: "*" means allow ALL)
// ============================================================
function filterComposioTools(tools: ToolSet): ToolSet {
  const allow = csvEnv("COMPOSIO_ALLOWED_TOOLS");

  // ✅ if unset or "*" => allow ALL
  if (!allow.length || allow.includes("*")) return tools;

  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    if (allow.includes(name)) out[name] = def;
  }
  return out as ToolSet;
}

async function getComposioToolsForUser(userId: string): Promise<ToolSet> {
  if (!env("COMPOSIO_API_KEY")) return {};

  const ttlMs = Math.max(0, parseIntOr(env("COMPOSIO_TOOLS_CACHE_TTL_MS"), 5 * 60_000));
  const now = Date.now();

  if (ttlMs > 0) {
    const cached = composioToolsCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.tools;
  }

  const userScoped = await composio.create(userId, { manageConnections: false } as any);
  const tools = (await userScoped.tools()) as ToolSet;
  const filtered = filterComposioTools(tools);

  if (ttlMs > 0) composioToolsCache.set(userId, { tools: filtered, expiresAt: now + ttlMs });
  return filtered;
}

async function composioListConnections(userId: string) {
  const userScoped = await composio.create(userId, { manageConnections: false } as any);
  const toolkits: any = await userScoped.toolkits();
  const items: any[] = toolkits?.items ?? [];

  // best-effort normalized view
  const normalized = items.map((t) => ({
    slug: String(t?.slug ?? t?.name ?? "").toLowerCase(),
    connected: Boolean(t?.connection?.connectedAccount?.id),
  }));

  return {
    ok: true,
    items: normalized.filter((x) => x.slug),
    connected: normalized.filter((x) => x.slug && x.connected).map((x) => x.slug),
  };
}

async function composioConnectLink(userId: string, toolkit: string) {
  const userScoped = await composio.create(userId, { manageConnections: false } as any);
  const callbackUrl = env("COMPOSIO_CALLBACK_URL") || undefined;
  const req: any = await userScoped.authorize(toolkit, callbackUrl ? { callbackUrl } : undefined);
  const link = String(req?.redirectUrl ?? req?.redirect_url ?? "");
  return { ok: Boolean(link), toolkit, link };
}

// ============================================================
// Telegram streaming helpers
// ============================================================
function createEditCoalescer(opts: {
  sessionId: string;
  messageId: number;
  throttleMs: number;
}) {
  let lastSent = "";
  let lastAt = 0;
  let inflight: Promise<void> | null = null;
  let pending: string | null = null;

  async function doEdit(text: string) {
    const t = clampNonEmptyText(text);
    if (t === lastSent) return;

    const now = Date.now();
    const wait = opts.throttleMs - (now - lastAt);
    if (wait > 0) await sleep(wait);

    try {
      await telegramEditMessageText(opts.sessionId, opts.messageId, t);
      lastSent = t;
      lastAt = Date.now();
    } catch {
      // best-effort
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

// ============================================================
// MAIN
// ============================================================
export async function agentTurn(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  history: ModelMessage[];
  showTyping?: boolean;
}) {
  "use step";

  const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";

  const messages = normalizeHistory(args.history);
  const userText = String(extractRecentUserText(messages) ?? "").trim();
  const hasImages = historyHasImages(messages);

  // Model selection (fast by default)
  const fastModel = env("FAST_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o-mini";
  const smartModel = env("SMART_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o";
  const modelName = hasImages ? smartModel : fastModel;

  const temperature = Number(env("MODEL_TEMPERATURE") ?? "0.2");

  // Telegram streaming + typing
  const isTelegram = args.channel === "telegram";
  const telegramStreamingEnabled =
    isTelegram &&
    (args.showTyping ?? true) &&
    (env("TELEGRAM_STREAMING") ?? "true") !== "false";

  const editThrottleMs = Math.max(250, Number(env("TELEGRAM_STREAM_EDIT_THROTTLE_MS") ?? 750));
  const typingIntervalMs = Math.max(1000, Number(env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
  const maxEditChars = Math.max(800, Math.min(3800, Number(env("TELEGRAM_STREAM_CHUNK_CHARS") ?? 3500)));

  let typingLoop: { stop: () => void } | null = null;
  let placeholderMsgId: number | null = null;

  // ============================================================
  // Tools: schedule + ssh + composio helper tools
  // ============================================================
  const scheduleMessage = tool({
    description: "Schedule a message back to this user/session after delaySeconds.",
    inputSchema: zodSchema(
      z.object({
        delaySeconds: z.number().min(1).max(60 * 60 * 24 * 14),
        text: z.string().min(1).max(2000),
      })
    ),
    execute: async (input: { delaySeconds: number; text: string }) => {
      const dueAt = Date.now() + Math.floor(input.delaySeconds * 1000);
      const id = await createSendTask({
        type: "send",
        dueAt,
        channel: args.channel,
        sessionId: args.sessionId,
        text: input.text,
        createdBy: "agent",
      } as any);
      return { ok: true, taskId: id, dueAt };
    },
  });

  const allowModelSsh = (env("SSH_TOOL_AUTONOMOUS") ?? "false") === "true";
  const sshTool = tool({
    description: allowModelSsh
      ? "Run any SSH command on the host."
      : "Run SSH only if user explicitly asked; otherwise instruct /ssh <command>.",
    inputSchema: zodSchema(z.object({ command: z.string().min(1).max(2000) })),
    execute: async (input: { command: string }) => {
      if (!allowModelSsh) {
        const explicit = userText.startsWith("/ssh") || /\bssh\b|\brun this command\b/i.test(userText);
        if (!explicit) return { ok: false, blocked: true, message: "Use /ssh <command> to run SSH." };
      }
      const output = await sshExec(input.command);
      return { ok: true, output };
    },
  });

  const connectToolkit = tool({
    description:
      "Generate a Composio connect/authorize link for a toolkit. Accepts user-friendly names like 'Typeform', 'Google Drive', or 'X'. Resolves by listing available Composio toolkits and choosing the closest match slug.",
    inputSchema: zodSchema(z.object({ toolkit: z.string().min(1) })),
    execute: async (input: { toolkit: string }) => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioConnectToolkitByName(args.userId, input.toolkit);
    },
  });

  const listConnections = tool({
    description: "List which Composio toolkits are connected for this user.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioListConnections(args.userId);
    },
  });

  // ============================================================
  // Fast-path /ssh command (instant, no model)
  // ============================================================
  const slash = parseSlashCommand(userText);
  if (slash?.cmd === "/ssh") {
    const cmd = slash.arg;
    const out = cmd ? await sshExec(cmd) : "Usage: /ssh <command>";
    return { text: String(out), responseMessages: [] as any[] };
  }

  // ============================================================
  // Build composio tools (ALWAYS load if COMPOSIO_API_KEY is set)
  // ============================================================
  let composioTools: ToolSet = {};
  if (env("COMPOSIO_API_KEY")) {
    composioTools = await getComposioToolsForUser(args.userId).catch(() => ({} as ToolSet));
  }

  const tools: ToolSet = {
    ...composioTools,
    schedule_message: scheduleMessage,
    ssh_exec: sshTool,
    connect_toolkit: connectToolkit,
    list_connections: listConnections,
  };

  // ============================================================
  // Telegram streaming helpers
  // ============================================================
  async function deliverFinalTelegram(text: string) {
    const chunks = splitForTelegram(text, maxEditChars);

    if (placeholderMsgId != null) {
      try {
        await telegramEditMessageText(args.sessionId, placeholderMsgId, chunks[0]);
      } catch {
        placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
      }
    } else {
      placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
    }

    for (let i = 1; i < chunks.length; i++) {
      await telegramSendMessage(args.sessionId, chunks[i], { disableNotification: true });
    }

    return { delivered: true };
  }

  async function streamToTelegram(textStream: AsyncIterable<string>): Promise<string> {
    let full = "";
    const editor = createEditCoalescer({
      sessionId: args.sessionId,
      messageId: placeholderMsgId!,
      throttleMs: editThrottleMs,
    });

    for await (const delta of textStream) {
      full += delta;
      // preview only (prevents spam)
      editor.request(full.slice(0, maxEditChars));
    }

    await editor.flush();
    return full;
  }

  // ============================================================
  // System prompt: force truthful tool use and auto-connect behavior
  // ============================================================
  const system = [
    "You are an assistant running inside Telegram/WhatsApp/SMS with Composio tools.",
    "",
    "CRITICAL TOOL RULES:",
    "- If the user asks you to do an external action (Twitter/X post, Typeform, Discord message, any and all tools etc.), you MUST use the appropriate tool.",
    "- Never claim an action succeeded unless a tool call returned success.",
    "- If a tool call fails due to missing auth/connection, immediately call connect_toolkit to generate a link and ask the user to connect, then retry the original tool call.",
    "- If you are unsure which toolkit is connected, call list_connections.",
    "",
    "SSH:",
    "- You can run SSH via ssh_exec if needed. If ssh_exec returns blocked, tell the user to use /ssh <command>.",
    "",
    `Mode: ${autonomy}`,
    "",
    "Be concise and correct. Avoid hallucinations.",
  ].join("\n");

  // ============================================================
  // Run generation (stream on Telegram)
  // ============================================================
  try {
    if (telegramStreamingEnabled) {
      typingLoop = telegramStartChatActionLoop(args.sessionId, "typing", { intervalMs: typingIntervalMs });
      placeholderMsgId = await telegramSendMessage(args.sessionId, "…", { disableNotification: true });

      const s = streamText({
        model: openai(modelName),
        system,
        messages,
        tools,
        temperature,
        stopWhen: stepCountIs(10),
      });

      const text = await streamToTelegram(s.textStream);
      await deliverFinalTelegram(text);
      return { text, responseMessages: [] as any[], delivered: true };
    }

    const r = await generateText({
      model: openai(modelName),
      system,
      messages,
      tools,
      temperature,
      stopWhen: stepCountIs(10),
    });

    return { text: r.text, responseMessages: (r.response?.messages as any[]) ?? [] };
  } finally {
    typingLoop?.stop();
  }
}
