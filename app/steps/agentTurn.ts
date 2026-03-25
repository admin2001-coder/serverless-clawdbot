/* agentTurn.ts */
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
import { Bash } from "just-bash";
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

function toSafeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function truncateText(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

function normalizeSkillName(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

// ============================================================
// Inline skill system (static, one-file, no external skill dirs)
// ============================================================
type InlineSkill = {
  name: string;
  whenToUse: string;
  guidance: string[];
  examples?: string[];
};

const INLINE_SKILLS: Record<string, InlineSkill> = {
  routing: {
    name: "routing",
    whenToUse: "Use first when deciding whether to answer directly, use virtual bash/files, SSH, scheduling, or Composio tools.",
    guidance: [
      "Prefer direct answer if no tool is required.",
      "Prefer virtual bash/files for analysis, transformation, scratch files, report generation, grep/jq/sed/awk, and dry-runs.",
      "Prefer ssh_exec only for real host-side execution the user actually wants.",
      "Prefer Composio tools for external apps/services.",
      "Never claim success for a tool-backed action unless the tool returned success.",
    ],
    examples: [
      "Draft shell script in virtual bash, then optionally run via ssh_exec.",
      "Summarize logs with bash/read_virtual_file.",
      "Use Composio if the user wants Slack/Gmail/Drive/etc actions.",
    ],
  },
  composio: {
    name: "composio",
    whenToUse: "Use when the user wants to act on external services via Composio.",
    guidance: [
      "If connectivity is uncertain, call list_connections.",
      "If the toolkit is not connected, call connect_toolkit.",
      "Do not fabricate external side effects.",
      "You can prepare payloads/content in virtual files before using external tools.",
    ],
    examples: [
      "Post to Discord, send Gmail, create a Typeform response flow, search Drive.",
    ],
  },
  ssh: {
    name: "ssh",
    whenToUse: "Use when the user explicitly wants execution on a real host or to inspect the actual remote environment.",
    guidance: [
      "Prefer virtual bash first for planning, linting commands, and dry-runs.",
      "Only use ssh_exec for real host actions.",
      "If blocked by policy, instruct the user to use /ssh <command>.",
      "Never say the host command worked unless ssh_exec returned success.",
    ],
    examples: [
      "Prepare a script in /workspace, inspect it, then run final host command via ssh_exec.",
    ],
  },
  scheduling: {
    name: "scheduling",
    whenToUse: "Use when the user explicitly asks for a delayed follow-up or reminder.",
    guidance: [
      "Use schedule_message only for explicit delayed messaging.",
      "Keep scheduled text concise and action-oriented.",
      "Confirm the delay implicitly by returning the task details.",
    ],
  },
  filesystem: {
    name: "filesystem",
    whenToUse: "Use for scratch files, text transforms, project inspection, and temporary artifacts.",
    guidance: [
      "Use write_virtual_file for reports, drafts, configs, JSON, and scripts.",
      "Use read_virtual_file when exact content is needed.",
      "Use just_bash for multi-step shell analysis.",
      "Keep work under /workspace.",
      "Prefer saving long outputs to files and summarizing them.",
    ],
    examples: [
      "Write /workspace/notes.md",
      "Read /workspace/context/request.json",
      "Run find/grep/sed/awk/jq in virtual bash",
    ],
  },
  telegram: {
    name: "telegram",
    whenToUse: "Use to shape responses for Telegram delivery constraints and user experience.",
    guidance: [
      "Be concise.",
      "Avoid huge walls of text when a file or summary is better.",
      "Streaming edits should be brief and stable.",
      "Long final responses can be chunked automatically by the transport layer.",
    ],
  },
};

function renderAllSkillsForPrompt(): string {
  const parts: string[] = [];
  for (const skill of Object.values(INLINE_SKILLS)) {
    parts.push(
      [
        `## Skill: ${skill.name}`,
        `When to use: ${skill.whenToUse}`,
        "Guidance:",
        ...skill.guidance.map((g) => `- ${g}`),
        ...(skill.examples?.length ? ["Examples:", ...skill.examples.map((e) => `- ${e}`)] : []),
      ].join("\n")
    );
  }
  return parts.join("\n\n");
}

function renderSingleSkill(skill: InlineSkill): string {
  return [
    `# ${skill.name}`,
    `When to use: ${skill.whenToUse}`,
    "",
    "Guidance:",
    ...skill.guidance.map((g) => `- ${g}`),
    ...(skill.examples?.length ? ["", "Examples:", ...skill.examples.map((e) => `- ${e}`)] : []),
  ].join("\n");
}

// ============================================================
// just-bash virtual runtime (per turn, sandboxed, in-memory)
// ============================================================
type VirtualRuntime = {
  bash: Bash;
  seededFiles: string[];
};

async function createVirtualRuntime(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  userText: string;
  history: ModelMessage[];
}): Promise<VirtualRuntime> {
  const skillsFiles: Record<string, string> = {};
  for (const skill of Object.values(INLINE_SKILLS)) {
    skillsFiles[`/workspace/skills/${skill.name}.md`] = renderSingleSkill(skill);
  }

  const files: Record<string, string> = {
    "/workspace/README.agent.txt": [
      "Virtual agent workspace.",
      "",
      "This filesystem is ephemeral for the current turn.",
      "Use it for scratch files, reports, transformations, generated code, and analysis.",
      "",
      `sessionId=${args.sessionId}`,
      `userId=${args.userId}`,
      `channel=${args.channel}`,
    ].join("\n"),

    "/workspace/context/request.json": toSafeJson({
      sessionId: args.sessionId,
      userId: args.userId,
      channel: args.channel,
      userText: args.userText,
      historyCount: args.history.length,
      createdAt: new Date().toISOString(),
    }),

    "/workspace/context/skills.index.json": toSafeJson({
      skills: Object.keys(INLINE_SKILLS),
    }),

    ...skillsFiles,
  };

  const bash = new Bash({
    cwd: "/workspace",
    files,
  } as any);

  return { bash, seededFiles: Object.keys(files) };
}

async function virtualWriteFile(runtime: VirtualRuntime, path: string, content: string) {
  const p = path.startsWith("/") ? path : `/workspace/${path}`;
  // just-bash exposes shell commands; write via heredoc to stay generic
  const marker = "__AGENT_EOF__";
  const cmd = [
    `mkdir -p "$(dirname '${p.replace(/'/g, `'\\''`)}')"`,
    `cat > '${p.replace(/'/g, `'\\''`)}' <<'${marker}'`,
    content,
    marker,
  ].join("\n");

  return runtime.bash.exec(cmd);
}

async function virtualReadFile(runtime: VirtualRuntime, path: string) {
  const p = path.startsWith("/") ? path : `/workspace/${path}`;
  return runtime.bash.exec(`cat '${p.replace(/'/g, `'\\''`)}'`);
}

async function virtualExec(runtime: VirtualRuntime, command: string) {
  return runtime.bash.exec(command);
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

  // Create per-turn virtual runtime with inline skills loaded as files
  const virtualRuntime = await createVirtualRuntime({
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    userText,
    history: messages,
  });

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

  const listSkills = tool({
    description: "List the statically inlined agent skills available in this file.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      return {
        ok: true,
        skills: Object.keys(INLINE_SKILLS),
        count: Object.keys(INLINE_SKILLS).length,
      };
    },
  });

  const readSkill = tool({
    description:
      "Read a specific inline skill by name, such as routing, composio, ssh, scheduling, filesystem, or telegram.",
    inputSchema: zodSchema(
      z.object({
        name: z.string().min(1),
      })
    ),
    execute: async (input: { name: string }) => {
      const key = normalizeSkillName(input.name);
      const skill = INLINE_SKILLS[key];
      if (!skill) {
        return {
          ok: false,
          error: `Unknown skill "${input.name}"`,
          available: Object.keys(INLINE_SKILLS),
        };
      }
      return {
        ok: true,
        skill: key,
        content: renderSingleSkill(skill),
        virtualPath: `/workspace/skills/${key}.md`,
      };
    },
  });

  const justBash = tool({
    description:
      "Run commands in a sandboxed virtual bash environment with an in-memory filesystem rooted at /workspace. Prefer this over SSH for safe analysis, dry-runs, parsing, grep/find/jq/sed/awk, and temporary artifacts.",
    inputSchema: zodSchema(
      z.object({
        command: z.string().min(1).max(12000),
      })
    ),
    execute: async (input: { command: string }) => {
      const cmd = String(input.command ?? "").trim();
      const blocked = [
        /\brm\s+-rf\s+\/\b/i,
        /\bshutdown\b/i,
        /\breboot\b/i,
        /\bpoweroff\b/i,
      ];
      if (blocked.some((re) => re.test(cmd))) {
        return {
          ok: false,
          blocked: true,
          message: "Blocked dangerous command in virtual bash environment.",
        };
      }

      try {
        const result: any = await virtualExec(virtualRuntime, cmd);
        return {
          ok: true,
          command: cmd,
          stdout: truncateText(result?.stdout ?? "", 20_000),
          stderr: truncateText(result?.stderr ?? "", 12_000),
          exitCode: result?.exitCode ?? result?.code ?? 0,
        };
      } catch (error: any) {
        return {
          ok: false,
          command: cmd,
          error: String(error?.message ?? error ?? "Unknown just_bash error"),
        };
      }
    },
  });

  const readVirtualFile = tool({
    description: "Read a file from the virtual in-memory filesystem. Prefer paths under /workspace.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
      })
    ),
    execute: async (input: { path: string }) => {
      try {
        const result: any = await virtualReadFile(virtualRuntime, input.path);
        const stdout = String(result?.stdout ?? "");
        const stderr = String(result?.stderr ?? "");
        const exitCode = result?.exitCode ?? result?.code ?? 0;
        if (exitCode !== 0) {
          return {
            ok: false,
            path: input.path,
            exitCode,
            error: truncateText(stderr || "File read failed", 12_000),
          };
        }
        return {
          ok: true,
          path: input.path,
          content: truncateText(stdout, 60_000),
        };
      } catch (error: any) {
        return {
          ok: false,
          path: input.path,
          error: String(error?.message ?? error ?? "Unknown read_virtual_file error"),
        };
      }
    },
  });

  const writeVirtualFile = tool({
    description: "Write content to a file in the virtual in-memory filesystem. Prefer /workspace paths.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
        content: z.string().max(200_000),
      })
    ),
    execute: async (input: { path: string; content: string }) => {
      try {
        const result: any = await virtualWriteFile(virtualRuntime, input.path, input.content);
        const exitCode = result?.exitCode ?? result?.code ?? 0;
        const stderr = String(result?.stderr ?? "");
        if (exitCode !== 0) {
          return {
            ok: false,
            path: input.path,
            exitCode,
            error: truncateText(stderr || "File write failed", 12_000),
          };
        }
        return {
          ok: true,
          path: input.path,
          bytes: Buffer.byteLength(input.content, "utf8"),
        };
      } catch (error: any) {
        return {
          ok: false,
          path: input.path,
          error: String(error?.message ?? error ?? "Unknown write_virtual_file error"),
        };
      }
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
    list_skills: listSkills,
    read_skill: readSkill,
    just_bash: justBash,
    read_virtual_file: readVirtualFile,
    write_virtual_file: writeVirtualFile,
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
      editor.request(full.slice(0, maxEditChars));
    }

    await editor.flush();
    return full;
  }

  // ============================================================
  // System prompt
  // ============================================================
  const system = [
    "You are an Agentic Operating System and assistant running inside Telegram/WhatsApp/SMS connected to Composio tools via auth configs.",
    "",
    "CRITICAL TOOL RULES:",
    "- If the user asks you to do an external action (Typeform, Twitter/X, Discord, Slack, etc.), you MUST use the appropriate tool.",
    "- Never claim an action succeeded unless a tool call returned success.",
    "- If an action requires the user to connect a toolkit, call connect_toolkit and give the link unless the user is already connected with their telegram userid.",
    "- If you're unsure what's connected, call list_connections.",
    "",
    "VIRTUAL BASH / FILESYSTEM:",
    "- You have just_bash, a sandboxed virtual bash environment with an in-memory filesystem rooted at /workspace.",
    "- You also have read_virtual_file and write_virtual_file for exact file IO in that virtual workspace.",
    "- Prefer just_bash over SSH for analysis, report generation, grep/find/jq/sed/awk, scratch files, and dry-runs.",
    "- The virtual filesystem is ephemeral for the current turn.",
    "",
    "SSH:",
    "- You can run SSH via ssh_exec if needed.",
    "- Prefer ssh_exec only for real host actions the user actually wants.",
    "- If blocked, tell the user to use /ssh <command>.",
    "",
    "SKILLS:",
    "- Agent skills are statically inlined in this file and also mounted into /workspace/skills/*.md.",
    "- You can use list_skills to discover them and read_skill to inspect one in detail.",
    "- Use these skills to choose the safest and most appropriate tool path.",
    "",
    `Mode: ${autonomy}`,
    "Be concise and correct. Avoid hallucinations.",
    "",
    "Inline skills reference:",
    renderAllSkillsForPrompt(),
  ].join("\n");

  // ============================================================
  // Run generation (Telegram streams + typing)
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
