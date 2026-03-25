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

function normalizeToolkitKey(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizePath(inputPath: string): string {
  let p = String(inputPath ?? "").trim();
  if (!p) p = "/workspace";
  if (!p.startsWith("/")) p = `/workspace/${p}`;
  p = p.replace(/\/+/g, "/");

  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }

  return `/${out.join("/")}`;
}

function dirname(p: string): string {
  const s = sanitizePath(p);
  const idx = s.lastIndexOf("/");
  if (idx <= 0) return "/";
  return s.slice(0, idx);
}

function basename(p: string): string {
  const s = sanitizePath(p);
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function parentDirs(p: string): string[] {
  const s = sanitizePath(p);
  const parts = s.split("/").filter(Boolean);
  const out = ["/"];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`;
    out.push(acc);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

// ============================================================
// Inline skill system
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
    whenToUse: "Use first when deciding whether to answer directly, use virtual files, SSH, scheduling, or Composio tools.",
    guidance: [
      "Prefer direct answer if no tool is required.",
      "Prefer virtual filesystem tools for drafting, transforming, analyzing, and staging content.",
      "Prefer ssh_exec only for real host-side execution the user explicitly wants.",
      "Prefer Composio tools for external apps/services and auth flows.",
      "Never claim success for a tool-backed action unless the tool returned success.",
    ],
  },
  composio: {
    name: "composio",
    whenToUse: "Use when the user wants to act on external services through Composio or connect a toolkit.",
    guidance: [
      "Namespace all Composio actions to the user ID passed into this agent turn.",
      "If connectivity is uncertain, call list_connections.",
      "If the toolkit is not connected, call connect_toolkit.",
      "Use auth config resolution when generating auth links.",
      "Do not fabricate external side effects.",
    ],
  },
  ssh: {
    name: "ssh",
    whenToUse: "Use when the user explicitly wants a real host command or remote inspection.",
    guidance: [
      "Prefer virtual files/tools first for planning and preparation.",
      "Only use ssh_exec for real host actions.",
      "If blocked, instruct the user to use /ssh <command>.",
    ],
  },
  scheduling: {
    name: "scheduling",
    whenToUse: "Use when the user explicitly asks for a delayed reminder or follow-up.",
    guidance: [
      "Use schedule_message only for explicit delayed messaging.",
      "Keep scheduled text concise and action-oriented.",
    ],
  },
  filesystem: {
    name: "filesystem",
    whenToUse: "Use for scratch files, reports, prompt staging, payload generation, and safe in-memory transforms.",
    guidance: [
      "Use read_virtual_file for exact file reads.",
      "Use write_virtual_file for drafts, JSON, markdown, scripts, configs, and reports.",
      "Use virtual_shell for listing/searching/moving/copying/deleting files in memory.",
      "Prefer keeping work under /workspace.",
    ],
  },
  telegram: {
    name: "telegram",
    whenToUse: "Use to optimize final responses for Telegram delivery behavior.",
    guidance: [
      "Be concise.",
      "Avoid giant walls of text when a summarized answer is enough.",
      "Long outputs can be staged in files and summarized.",
    ],
  },
};

function renderAllSkillsForPrompt(): string {
  return Object.values(INLINE_SKILLS)
    .map((skill) =>
      [
        `## Skill: ${skill.name}`,
        `When to use: ${skill.whenToUse}`,
        "Guidance:",
        ...skill.guidance.map((g) => `- ${g}`),
        ...(skill.examples?.length ? ["Examples:", ...skill.examples.map((e) => `- ${e}`)] : []),
      ].join("\n")
    )
    .join("\n\n");
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
// Pure TypeScript virtual filesystem + shell-like runtime
// ============================================================
type VfsNode =
  | {
      type: "file";
      path: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "dir";
      path: string;
      createdAt: string;
      updatedAt: string;
    };

type VirtualRuntime = {
  cwd: string;
  nodes: Map<string, VfsNode>;
};

function createVirtualRuntime(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  userText: string;
  history: ModelMessage[];
}): VirtualRuntime {
  const rt: VirtualRuntime = {
    cwd: "/workspace",
    nodes: new Map<string, VfsNode>(),
  };

  function ensureDir(path: string) {
    const p = sanitizePath(path);
    if (rt.nodes.has(p)) return;
    rt.nodes.set(p, {
      type: "dir",
      path: p,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  function writeFile(path: string, content: string) {
    const p = sanitizePath(path);
    for (const dir of parentDirs(p)) ensureDir(dir);
    const existing = rt.nodes.get(p);
    rt.nodes.set(p, {
      type: "file",
      path: p,
      content,
      createdAt: existing?.type === "file" ? existing.createdAt : nowIso(),
      updatedAt: nowIso(),
    });
  }

  ensureDir("/");
  ensureDir("/workspace");
  ensureDir("/workspace/context");
  ensureDir("/workspace/skills");

  writeFile(
    "/workspace/README.agent.txt",
    [
      "Virtual agent workspace.",
      "",
      "This filesystem is ephemeral for the current turn.",
      "Use it for scratch files, reports, payloads, drafts, and analysis artifacts.",
      "",
      `sessionId=${args.sessionId}`,
      `userId=${args.userId}`,
      `channel=${args.channel}`,
    ].join("\n")
  );

  writeFile(
    "/workspace/context/request.json",
    toSafeJson({
      sessionId: args.sessionId,
      userId: args.userId,
      channel: args.channel,
      userText: args.userText,
      historyCount: args.history.length,
      createdAt: nowIso(),
    })
  );

  writeFile(
    "/workspace/context/skills.index.json",
    toSafeJson({
      skills: Object.keys(INLINE_SKILLS),
    })
  );

  for (const skill of Object.values(INLINE_SKILLS)) {
    writeFile(`/workspace/skills/${skill.name}.md`, renderSingleSkill(skill));
  }

  return rt;
}

function vfsGetNode(rt: VirtualRuntime, path: string): VfsNode | undefined {
  return rt.nodes.get(sanitizePath(path));
}

function vfsEnsureDir(rt: VirtualRuntime, path: string) {
  const p = sanitizePath(path);
  if (rt.nodes.has(p)) {
    const node = rt.nodes.get(p)!;
    if (node.type !== "dir") throw new Error(`Path exists and is not a directory: ${p}`);
    return;
  }
  for (const dir of parentDirs(p)) {
    if (!rt.nodes.has(dir)) {
      rt.nodes.set(dir, {
        type: "dir",
        path: dir,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }
  rt.nodes.set(p, {
    type: "dir",
    path: p,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

function vfsWriteFile(rt: VirtualRuntime, path: string, content: string) {
  const p = sanitizePath(path);
  for (const dir of parentDirs(p)) vfsEnsureDir(rt, dir);
  const existing = rt.nodes.get(p);
  rt.nodes.set(p, {
    type: "file",
    path: p,
    content,
    createdAt: existing?.type === "file" ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
  });
}

function vfsReadFile(rt: VirtualRuntime, path: string): string {
  const p = sanitizePath(path);
  const node = rt.nodes.get(p);
  if (!node) throw new Error(`No such file: ${p}`);
  if (node.type !== "file") throw new Error(`Not a file: ${p}`);
  return node.content;
}

function vfsList(rt: VirtualRuntime, path: string, recursive = false): string[] {
  const p = sanitizePath(path);
  const node = rt.nodes.get(p);
  if (!node) throw new Error(`No such path: ${p}`);

  const keys = [...rt.nodes.keys()].sort();
  if (node.type === "file") return [p];

  if (!recursive) {
    return keys.filter((k) => dirname(k) === p && k !== p).sort();
  }

  return keys.filter((k) => k === p || k.startsWith(p === "/" ? "/" : `${p}/`)).sort();
}

function vfsDelete(rt: VirtualRuntime, path: string, recursive = false) {
  const p = sanitizePath(path);
  const node = rt.nodes.get(p);
  if (!node) throw new Error(`No such path: ${p}`);

  if (node.type === "file") {
    rt.nodes.delete(p);
    return;
  }

  const children = [...rt.nodes.keys()].filter((k) => k !== p && k.startsWith(`${p}/`));
  if (children.length && !recursive) {
    throw new Error(`Directory not empty: ${p}`);
  }
  for (const child of children) rt.nodes.delete(child);
  rt.nodes.delete(p);
}

function vfsMove(rt: VirtualRuntime, fromPath: string, toPath: string) {
  const from = sanitizePath(fromPath);
  const to = sanitizePath(toPath);
  const node = rt.nodes.get(from);
  if (!node) throw new Error(`No such path: ${from}`);

  if (node.type === "file") {
    vfsWriteFile(rt, to, node.content);
    rt.nodes.delete(from);
    return;
  }

  const entries = [...rt.nodes.entries()]
    .filter(([p]) => p === from || p.startsWith(`${from}/`))
    .sort((a, b) => a[0].length - b[0].length);

  for (const [oldPath, oldNode] of entries) {
    const suffix = oldPath === from ? "" : oldPath.slice(from.length);
    const newPath = sanitizePath(`${to}${suffix}`);
    if (oldNode.type === "dir") {
      vfsEnsureDir(rt, newPath);
    } else {
      vfsWriteFile(rt, newPath, oldNode.content);
    }
  }

  for (const [oldPath] of entries.reverse()) {
    rt.nodes.delete(oldPath);
  }
}

function vfsCopy(rt: VirtualRuntime, fromPath: string, toPath: string) {
  const from = sanitizePath(fromPath);
  const to = sanitizePath(toPath);
  const node = rt.nodes.get(from);
  if (!node) throw new Error(`No such path: ${from}`);

  if (node.type === "file") {
    vfsWriteFile(rt, to, node.content);
    return;
  }

  const entries = [...rt.nodes.entries()]
    .filter(([p]) => p === from || p.startsWith(`${from}/`))
    .sort((a, b) => a[0].length - b[0].length);

  for (const [oldPath, oldNode] of entries) {
    const suffix = oldPath === from ? "" : oldPath.slice(from.length);
    const newPath = sanitizePath(`${to}${suffix}`);
    if (oldNode.type === "dir") {
      vfsEnsureDir(rt, newPath);
    } else {
      vfsWriteFile(rt, newPath, oldNode.content);
    }
  }
}

function vfsFind(rt: VirtualRuntime, path: string, needle: string): string[] {
  const base = sanitizePath(path);
  const all = vfsList(rt, base, true);
  const q = needle.toLowerCase();
  return all.filter((p) => p.toLowerCase().includes(q));
}

function vfsGrep(rt: VirtualRuntime, path: string, query: string): Array<{ path: string; line: number; text: string }> {
  const base = sanitizePath(path);
  const all = vfsList(rt, base, true);
  const q = query.toLowerCase();
  const out: Array<{ path: string; line: number; text: string }> = [];

  for (const p of all) {
    const node = rt.nodes.get(p);
    if (!node || node.type !== "file") continue;
    const lines = node.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        out.push({ path: p, line: i + 1, text: lines[i] });
      }
    }
  }

  return out;
}

function virtualShellHelp() {
  return [
    "Supported commands:",
    "- pwd",
    "- ls [path]",
    "- tree [path]",
    "- cat <path>",
    "- mkdir <path>",
    "- write <path> <<<TEXT>>>",
    "- rm <path>",
    "- rm -r <path>",
    "- mv <from> <to>",
    "- cp <from> <to>",
    "- find <path> <needle>",
    "- grep <path> <needle>",
    "",
    "Notes:",
    "- This is an in-memory virtual filesystem only.",
    "- Paths default under /workspace when relative.",
    "- For exact file writes/reads, prefer write_virtual_file/read_virtual_file.",
  ].join("\n");
}

function parseVirtualShell(input: string): { ok: true; result: any } | { ok: false; error: string } {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Empty command" };

  if (raw === "help" || raw === "--help") {
    return { ok: true, result: { command: raw, mode: "help" } };
  }

  const writeMatch = raw.match(/^write\s+(\S+)\s+<<<([\s\S]*)>>>$/);
  if (writeMatch) {
    return {
      ok: true,
      result: {
        command: "write",
        path: writeMatch[1],
        content: writeMatch[2],
      },
    };
  }

  const parts = raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^['"]|['"]$/g, "")) ?? [];
  if (!parts.length) return { ok: false, error: "Unable to parse command" };

  const [command, ...rest] = parts;
  return {
    ok: true,
    result: {
      command,
      args: rest,
    },
  };
}

function execVirtualShell(rt: VirtualRuntime, input: string) {
  const parsed = parseVirtualShell(input);
  if (!parsed.ok) {
    return {
      ok: false,
      stdout: "",
      stderr: parsed.error,
      exitCode: 2,
    };
  }

  const spec = parsed.result;

  try {
    if (spec.mode === "help") {
      return {
        ok: true,
        stdout: virtualShellHelp(),
        stderr: "",
        exitCode: 0,
      };
    }

    if (spec.command === "write") {
      vfsWriteFile(rt, spec.path, spec.content);
      return {
        ok: true,
        stdout: `Wrote ${sanitizePath(spec.path)}`,
        stderr: "",
        exitCode: 0,
      };
    }

    const args = spec.args ?? [];

    switch (spec.command) {
      case "pwd":
        return { ok: true, stdout: rt.cwd, stderr: "", exitCode: 0 };

      case "ls": {
        const target = args[0] ?? rt.cwd;
        const items = vfsList(rt, target, false);
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "tree": {
        const target = args[0] ?? rt.cwd;
        const items = vfsList(rt, target, true);
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "cat": {
        if (!args[0]) throw new Error("cat requires a path");
        const content = vfsReadFile(rt, args[0]);
        return { ok: true, stdout: content, stderr: "", exitCode: 0 };
      }

      case "mkdir": {
        if (!args[0]) throw new Error("mkdir requires a path");
        vfsEnsureDir(rt, args[0]);
        return { ok: true, stdout: `Created ${sanitizePath(args[0])}`, stderr: "", exitCode: 0 };
      }

      case "rm": {
        if (!args.length) throw new Error("rm requires a path");
        const recursive = args[0] === "-r";
        const target = recursive ? args[1] : args[0];
        if (!target) throw new Error("rm requires a path");
        vfsDelete(rt, target, recursive);
        return { ok: true, stdout: `Removed ${sanitizePath(target)}`, stderr: "", exitCode: 0 };
      }

      case "mv": {
        if (args.length < 2) throw new Error("mv requires <from> <to>");
        vfsMove(rt, args[0], args[1]);
        return {
          ok: true,
          stdout: `Moved ${sanitizePath(args[0])} -> ${sanitizePath(args[1])}`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "cp": {
        if (args.length < 2) throw new Error("cp requires <from> <to>");
        vfsCopy(rt, args[0], args[1]);
        return {
          ok: true,
          stdout: `Copied ${sanitizePath(args[0])} -> ${sanitizePath(args[1])}`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "find": {
        if (args.length < 2) throw new Error("find requires <path> <needle>");
        const items = vfsFind(rt, args[0], args.slice(1).join(" "));
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "grep": {
        if (args.length < 2) throw new Error("grep requires <path> <needle>");
        const items = vfsGrep(rt, args[0], args.slice(1).join(" "));
        return {
          ok: true,
          stdout: items.map((x) => `${x.path}:${x.line}:${x.text}`).join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }

      default:
        return {
          ok: false,
          stdout: "",
          stderr: `Unsupported virtual command "${spec.command}".\n\n${virtualShellHelp()}`,
          exitCode: 2,
        };
    }
  } catch (error: any) {
    return {
      ok: false,
      stdout: "",
      stderr: String(error?.message ?? error ?? "Virtual shell error"),
      exitCode: 1,
    };
  }
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
      authConfigId:
        t?.connection?.authConfig?.id ??
        t?.authConfig?.id ??
        t?.defaultAuthConfig?.id ??
        null,
    }))
    .filter((x) => x.slug);

  return {
    ok: true,
    namespace: userId,
    items: normalized.map((x) => ({
      slug: x.slug,
      connected: x.connected,
      authConfigId: x.authConfigId,
    })),
    connected: normalized.filter((x) => x.connected).map((x) => x.slug),
  };
}

function resolveConfiguredAuthConfigId(toolkitSlug: string): string | undefined {
  const slugKey = normalizeToolkitKey(toolkitSlug);
  const directEnvKey = `COMPOSIO_AUTH_CONFIG_${slugKey.toUpperCase()}`;
  const direct = env(directEnvKey);
  if (direct) return direct;

  const legacyEnvKey = `COMPOSIO_AUTHCONFIG_${slugKey.toUpperCase()}`;
  const legacy = env(legacyEnvKey);
  if (legacy) return legacy;

  const mapRaw = env("COMPOSIO_AUTH_CONFIG_MAP") || env("COMPOSIO_AUTHCONFIG_MAP");
  if (mapRaw) {
    try {
      const parsed = JSON.parse(mapRaw) as Record<string, string>;
      const exact =
        parsed[toolkitSlug] ??
        parsed[toolkitSlug.toLowerCase()] ??
        parsed[slugKey];
      if (exact) return String(exact);
    } catch {
      // ignore invalid JSON, fallback below
    }
  }

  return env("COMPOSIO_DEFAULT_AUTH_CONFIG_ID") || env("COMPOSIO_DEFAULT_AUTHCONFIG_ID") || undefined;
}

async function composioResolveToolkitAndAuthConfig(userId: string, toolkitInput: string) {
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

      const discoveredAuthConfigId =
        t?.connection?.authConfig?.id ??
        t?.authConfig?.id ??
        t?.defaultAuthConfig?.id ??
        null;

      return {
        slug,
        name,
        slugNorm,
        nameNorm,
        connected,
        discoveredAuthConfigId,
      };
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
      ok: false as const,
      error: `Toolkit "${toolkitInput}" not found in Composio toolkits list.`,
      hint: `Try one of: ${top}`,
    };
  }

  const configuredAuthConfigId = resolveConfiguredAuthConfigId(match.slug);
  const resolvedAuthConfigId = configuredAuthConfigId ?? match.discoveredAuthConfigId ?? undefined;

  return {
    ok: true as const,
    toolkit: match.slug,
    connected: match.connected,
    authConfigId: resolvedAuthConfigId,
    authConfigSource: configuredAuthConfigId ? "env" : match.discoveredAuthConfigId ? "discovered" : "none",
  };
}

async function composioConnectToolkitByName(userId: string, toolkitInput: string) {
  const resolved = await composioResolveToolkitAndAuthConfig(userId, toolkitInput);
  if (!resolved.ok) return resolved;

  const userScoped = await composio.create(userId, {
    manageConnections: false,
  } as any);

  const callbackUrl = env("COMPOSIO_CALLBACK_URL") || undefined;

  const authorizeOptionsVariants = [
    {
      callbackUrl,
      authConfigId: resolved.authConfigId,
    },
    {
      callbackUrl,
      auth_config_id: resolved.authConfigId,
    },
    {
      callback_url: callbackUrl,
      authConfigId: resolved.authConfigId,
    },
    {
      callback_url: callbackUrl,
      auth_config_id: resolved.authConfigId,
    },
    callbackUrl ? { callbackUrl } : {},
  ].filter(Boolean) as any[];

  let lastError: unknown = null;
  let req: any = null;

  for (const opts of authorizeOptionsVariants) {
    try {
      req = await userScoped.authorize(resolved.toolkit, opts);
      if (req) break;
    } catch (error) {
      lastError = error;
    }
  }

  const link = String(
    req?.redirectUrl ??
      req?.redirect_url ??
      req?.url ??
      req?.link ??
      ""
  );

  if (!link) {
    return {
      ok: false,
      namespace: userId,
      toolkit: resolved.toolkit,
      authConfigId: resolved.authConfigId ?? null,
      authConfigSource: resolved.authConfigSource,
      error: `Failed to generate auth link for toolkit "${resolved.toolkit}" under namespace "${userId}".`,
      details: lastError ? String((lastError as any)?.message ?? lastError) : "No redirect URL returned by Composio authorize()",
    };
  }

  return {
    ok: true,
    namespace: userId,
    toolkit: resolved.toolkit,
    link,
    alreadyConnected: resolved.connected,
    authConfigId: resolved.authConfigId ?? null,
    authConfigSource: resolved.authConfigSource,
  };
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

  const virtualRuntime = createVirtualRuntime({
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    userText,
    history: messages,
  });

  const fastModel = env("FAST_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o-mini";
  const smartModel = env("SMART_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o";
  const modelName = hasImages ? smartModel : fastModel;

  const temperature = Number(env("MODEL_TEMPERATURE") ?? "0.2");

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
      "Generate a Composio connect/authorize link for a toolkit using the current user's namespace. Accepts user-friendly names like 'Typeform', 'Google Drive', or 'X'. Resolves toolkit slug and auth config before creating the auth link.",
    inputSchema: zodSchema(
      z.object({
        toolkit: z.string().min(1),
      })
    ),
    execute: async (input: { toolkit: string }) => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioConnectToolkitByName(args.userId, input.toolkit);
    },
  });

  const listConnections = tool({
    description: "List which Composio toolkits are connected for this user namespace.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioListConnections(args.userId);
    },
  });

  const resolveToolkitConnection = tool({
    description:
      "Resolve the best Composio toolkit slug and auth config for a requested toolkit name, under this user's namespace.",
    inputSchema: zodSchema(
      z.object({
        toolkit: z.string().min(1),
      })
    ),
    execute: async (input: { toolkit: string }) => {
      if (!env("COMPOSIO_API_KEY")) return { ok: false, error: "COMPOSIO_API_KEY not set" };
      return composioResolveToolkitAndAuthConfig(args.userId, input.toolkit);
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

  const readVirtualFile = tool({
    description: "Read a file from the virtual in-memory filesystem. Prefer paths under /workspace.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
      })
    ),
    execute: async (input: { path: string }) => {
      try {
        const content = vfsReadFile(virtualRuntime, input.path);
        return {
          ok: true,
          path: sanitizePath(input.path),
          content: truncateText(content, 60_000),
        };
      } catch (error: any) {
        return {
          ok: false,
          path: sanitizePath(input.path),
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
        vfsWriteFile(virtualRuntime, input.path, input.content);
        return {
          ok: true,
          path: sanitizePath(input.path),
          bytes: Buffer.byteLength(input.content, "utf8"),
        };
      } catch (error: any) {
        return {
          ok: false,
          path: sanitizePath(input.path),
          error: String(error?.message ?? error ?? "Unknown write_virtual_file error"),
        };
      }
    },
  });

  const virtualShell = tool({
    description:
      "Run shell-like commands against the in-memory virtual filesystem only. Supports pwd, ls, tree, cat, mkdir, write, rm, mv, cp, find, and grep. This does not touch the host OS.",
    inputSchema: zodSchema(
      z.object({
        command: z.string().min(1).max(12000),
      })
    ),
    execute: async (input: { command: string }) => {
      const result = execVirtualShell(virtualRuntime, input.command);
      return {
        ok: result.ok,
        command: input.command,
        stdout: truncateText(result.stdout, 20_000),
        stderr: truncateText(result.stderr, 12_000),
        exitCode: result.exitCode,
      };
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
  // Load Composio tools
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
    resolve_toolkit_connection: resolveToolkitConnection,
    list_skills: listSkills,
    read_skill: readSkill,
    read_virtual_file: readVirtualFile,
    write_virtual_file: writeVirtualFile,
    virtual_shell: virtualShell,
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
    "- If an action requires the user to connect a toolkit, call connect_toolkit and provide the link.",
    "- If you're unsure what's connected, call list_connections.",
    "- If you need to know which auth config and toolkit slug will be used, call resolve_toolkit_connection.",
    "",
    "COMPOSIO NAMESPACE:",
    `- The active Composio namespace for this turn is the user's ID: ${args.userId}`,
    "- All auth links and connected accounts should be treated as belonging to that namespace.",
    "",
    "VIRTUAL FILESYSTEM:",
    "- You have read_virtual_file and write_virtual_file for a safe in-memory filesystem.",
    "- You also have virtual_shell for shell-like operations against that virtual filesystem only.",
    "- Prefer virtual filesystem tools for drafting, staging, payload prep, notes, reports, JSON, and scratch work.",
    "- The virtual filesystem is ephemeral for the current turn.",
    "",
    "SSH:",
    "- You can run SSH via ssh_exec if needed.",
    "- Prefer ssh_exec only for real host actions the user actually wants.",
    "- If blocked, tell the user to use /ssh <command>.",
    "",
    "SKILLS:",
    "- Agent skills are statically inlined in this file and also mounted into virtual files under /workspace/skills/*.md.",
    "- You can use list_skills and read_skill when useful.",
    "",
    `Mode: ${autonomy}`,
    "Be concise and correct. Avoid hallucinations.",
    "",
    "Inline skills reference:",
    renderAllSkillsForPrompt(),
  ].join("\n");

  // ============================================================
  // Run generation
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
