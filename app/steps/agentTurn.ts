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
import { createHmac } from "node:crypto";
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
// Upstash Redis-backed VFS
// ============================================================
type RedisClient = any;

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
  sessionId: string;
  userId: string;
  channel: Channel;
  redis: RedisClient;
};

let redisClientPromise: Promise<RedisClient | null> | null = null;

async function getRedisClient(): Promise<RedisClient | null> {
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

      if (!url || !token) return null;

      const { Redis } = await import("@upstash/redis");
      return new Redis({ url, token });
    })().catch(() => null);
  }

  return redisClientPromise;
}

function vfsNamespace(userId: string, sessionId: string): string {
  return `vfs:${userId}:${sessionId}`;
}

function vfsPathsKey(userId: string, sessionId: string): string {
  return `${vfsNamespace(userId, sessionId)}:paths`;
}

function vfsNodeKey(userId: string, sessionId: string, path: string): string {
  return `${vfsNamespace(userId, sessionId)}:node:${sanitizePath(path)}`;
}

function vfsMetaKey(userId: string, sessionId: string): string {
  return `${vfsNamespace(userId, sessionId)}:meta`;
}

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

function truncateText(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

function normalizeHistory(history: ModelMessage[]): ModelMessage[] {
  return (history ?? []).map((m) => {
    const c: any = (m as any).content;
    if (typeof c === "string") {
      return { ...m, content: [{ type: "text" as const, text: c }] } as any;
    }
    return m;
  });
}

function extractRecentUserText(history: ModelMessage[]): string {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const c: any = (lastUser as any).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const textParts = c.filter((p) => p?.type === "text" && typeof p?.text === "string").map((p) => p.text);
    return textParts.join("\n").trim();
  }
  return "";
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

function isProbablyUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:/i.test(value.trim());
}

function safeFilenameSegment(value: string): string {
  const s = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "asset";
}

function inferExtensionFromMime(mimeType: string): string {
  const mime = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-msvideo": "avi",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/zip": "zip",
  };
  return map[mime] ?? "bin";
}

function inferMimeFromFilename(name: string): string {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    webm: "video/webm",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function guessMimeTypeFromKind(kind: SessionAssetKind): string {
  switch (kind) {
    case "image":
      return "image/*";
    case "audio":
      return "audio/*";
    case "video":
      return "video/*";
    default:
      return "application/octet-stream";
  }
}

function extractMimeTypeFromDataUrl(dataUrl: string): string {
  const match = String(dataUrl ?? "").match(/^data:([^;,]+)(;base64)?,/i);
  return match?.[1]?.toLowerCase() ?? "application/octet-stream";
}

function stripDataUrlPrefix(dataUrl: string): string {
  return String(dataUrl ?? "").replace(/^data:[^,]*,/, "");
}

function estimateBase64Bytes(base64: string): number | null {
  const s = String(base64 ?? "").trim();
  if (!s) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

function tryUtf8FromBase64(base64: string): string | null {
  try {
    return Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function isTextualMimeType(mimeType: string): boolean {
  const mime = String(mimeType ?? "").toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("yaml") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("csv")
  );
}

function pickFirstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// ============================================================
// Session asset model
// ============================================================
type SessionAssetKind = "image" | "audio" | "video" | "file";
type SessionAssetSource = "url" | "data_url" | "base64" | "text" | "unknown";

type SessionAsset = {
  id: string;
  kind: SessionAssetKind;
  role: string;
  messageIndex: number;
  partIndex: number;
  partType: string;
  filename: string;
  mimeType: string;
  extension: string;
  source: SessionAssetSource;
  url?: string;
  dataUrl?: string;
  base64?: string;
  text?: string;
  sizeBytes?: number | null;
};

type LoadedSessionAsset = {
  base64: string;
  mimeType: string;
  filename: string;
  sizeBytes: number | null;
  source: SessionAssetSource | "fetched_url";
  textPreview?: string | null;
  dataUrl?: string;
};

function isRichMediaPartType(type: string): boolean {
  return ["image", "audio", "video", "file"].includes(String(type ?? "").toLowerCase());
}

function historyHasRichMedia(history: ModelMessage[]): boolean {
  for (const msg of history) {
    const c: any = (msg as any).content;
    if (!Array.isArray(c)) continue;
    if (c.some((p) => isRichMediaPartType(String(p?.type ?? "")))) return true;
  }
  return false;
}

function assetKindFromPart(part: any): SessionAssetKind | null {
  const type = String(part?.type ?? "").toLowerCase();
  if (["image", "audio", "video", "file"].includes(type)) return type as SessionAssetKind;
  if (part?.image || part?.image_url) return "image";
  if (part?.audio || part?.input_audio) return "audio";
  if (part?.video) return "video";
  if (part?.file || part?.filename || part?.mimeType || part?.mediaType) return "file";
  return null;
}

function rawAssetPayloadFromPart(part: any, kind: SessionAssetKind): unknown {
  switch (kind) {
    case "image":
      return pickFirstDefined(part?.image, part?.image_url, part?.url, part?.uri, part?.data);
    case "audio":
      return pickFirstDefined(part?.audio, part?.input_audio?.data, part?.url, part?.uri, part?.data);
    case "video":
      return pickFirstDefined(part?.video, part?.url, part?.uri, part?.data);
    default:
      return pickFirstDefined(part?.file, part?.url, part?.uri, part?.data, part?.bytes, part?.content);
  }
}

function coerceAssetSource(payload: unknown): {
  source: SessionAssetSource;
  url?: string;
  dataUrl?: string;
  base64?: string;
  text?: string;
  sizeBytes?: number | null;
} {
  if (payload == null) return { source: "unknown", sizeBytes: null };

  if (typeof payload === "string") {
    if (isProbablyUrl(payload)) return { source: "url", url: payload.trim(), sizeBytes: null };
    if (isDataUrl(payload)) {
      const base64 = stripDataUrlPrefix(payload);
      return { source: "data_url", dataUrl: payload, base64, sizeBytes: estimateBase64Bytes(base64) };
    }
    return { source: "text", text: payload, sizeBytes: Buffer.byteLength(payload, "utf8") };
  }

  if (payload instanceof Uint8Array) {
    const base64 = Buffer.from(payload).toString("base64");
    return { source: "base64", base64, sizeBytes: payload.byteLength };
  }

  if (Array.isArray(payload) && payload.every((x) => typeof x === "number")) {
    const base64 = Buffer.from(payload).toString("base64");
    return { source: "base64", base64, sizeBytes: payload.length };
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(payload)) {
    const base64 = payload.toString("base64");
    return { source: "base64", base64, sizeBytes: payload.length };
  }

  if (typeof payload === "object") {
    const obj: any = payload;
    const nested = pickFirstDefined(obj?.url, obj?.uri, obj?.href, obj?.data, obj?.base64, obj?.content);
    if (nested !== undefined) return coerceAssetSource(nested);
  }

  return { source: "unknown", text: truncateText(payload, 2000), sizeBytes: null };
}

function buildSessionAsset(part: any, role: string, messageIndex: number, partIndex: number): SessionAsset | null {
  const kind = assetKindFromPart(part);
  if (!kind) return null;

  const partType = String(part?.type ?? kind).toLowerCase();
  const payload = rawAssetPayloadFromPart(part, kind);
  const sourceInfo = coerceAssetSource(payload);

  let mimeType =
    String(
      pickFirstDefined(
        part?.mimeType,
        part?.mediaType,
        part?.contentType,
        part?.input_audio?.format ? `audio/${String(part.input_audio.format).toLowerCase()}` : undefined,
        sourceInfo.dataUrl ? extractMimeTypeFromDataUrl(sourceInfo.dataUrl) : undefined
      ) ?? ""
    ).toLowerCase() || guessMimeTypeFromKind(kind);

  const explicitFilename = String(
    pickFirstDefined(part?.filename, part?.name, part?.fileName, part?.title, part?.metadata?.filename) ?? ""
  ).trim();

  const extension = explicitFilename.includes(".")
    ? explicitFilename.split(".").pop()!.toLowerCase()
    : inferExtensionFromMime(mimeType);

  const filename = explicitFilename || `asset_${messageIndex + 1}_${partIndex + 1}.${extension}`;

  if (!mimeType || mimeType === "application/octet-stream") {
    mimeType = inferMimeFromFilename(filename) || mimeType;
  }

  return {
    id: `asset_m${messageIndex + 1}_p${partIndex + 1}`,
    kind,
    role,
    messageIndex,
    partIndex,
    partType,
    filename: safeFilenameSegment(filename),
    mimeType,
    extension: extension || inferExtensionFromMime(mimeType),
    source: sourceInfo.source,
    url: sourceInfo.url,
    dataUrl: sourceInfo.dataUrl,
    base64: sourceInfo.base64,
    text: sourceInfo.text,
    sizeBytes: sourceInfo.sizeBytes ?? null,
  };
}

function collectSessionAssets(history: ModelMessage[]): SessionAsset[] {
  const assets: SessionAsset[] = [];
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const msg: any = history[messageIndex];
    const content = msg?.content;
    if (!Array.isArray(content)) continue;

    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const asset = buildSessionAsset(content[partIndex], String(msg?.role ?? "user"), messageIndex, partIndex);
      if (asset) assets.push(asset);
    }
  }
  return assets;
}

// ============================================================
// Prompt-safe message sanitization
// ============================================================
function mediaPartToTextPlaceholder(part: any): { type: "text"; text: string } {
  const type = String(part?.type ?? "file").toLowerCase();
  const filename = String(part?.filename ?? part?.name ?? part?.fileName ?? "").trim();
  const mimeType = String(part?.mimeType ?? part?.mediaType ?? part?.contentType ?? "").trim();

  const label = [type, filename || undefined, mimeType || undefined].filter(Boolean).join(" | ");
  return {
    type: "text",
    text: `[${label || "media attachment"} omitted from prompt context; use session asset tools]`,
  };
}

function sanitizeMessagesForModel(history: ModelMessage[]): ModelMessage[] {
  const maxMessages = Math.max(4, parseIntOr(env("AGENT_MAX_HISTORY_MESSAGES"), 12));
  const maxTextChars = Math.max(1000, parseIntOr(env("AGENT_MAX_TEXT_PART_CHARS"), 12000));
  const trimmed = history.slice(-maxMessages);

  const out: ModelMessage[] = [];

  for (const msg of trimmed) {
    const role = String((msg as any).role ?? "");

    // Tool role messages are the most likely to violate schema if reused naively.
    // Drop them from the prompt transcript.
    if (role === "tool") continue;

    const content: any = (msg as any).content;

    if (typeof content === "string") {
      if (role === "system" || role === "user" || role === "assistant") {
        out.push({ ...msg, content: clampNonEmptyText(truncateText(content, maxTextChars)) } as any);
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    const safeParts: any[] = [];
    for (const part of content) {
      const type = String(part?.type ?? "");

      if (type === "text") {
        safeParts.push({
          type: "text",
          text: clampNonEmptyText(truncateText(String(part?.text ?? ""), maxTextChars)),
        });
        continue;
      }

      if (type === "image" || type === "audio" || type === "video" || type === "file") {
        safeParts.push(mediaPartToTextPlaceholder(part));
        continue;
      }
    }

    if (!safeParts.length) {
      safeParts.push({ type: "text", text: "…" });
    }

    if (role === "user" || role === "assistant") {
      out.push({ ...msg, content: safeParts } as any);
    } else if (role === "system") {
      const systemText = safeParts.map((p) => p.text).join("\n");
      out.push({ role: "system", content: clampNonEmptyText(systemText) } as any);
    }
  }

  return out;
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
    whenToUse: "Use for scratch files, reports, prompt staging, payload generation, and safe transforms.",
    guidance: [
      "Use read_virtual_file for exact file reads.",
      "Use write_virtual_file for drafts, JSON, markdown, scripts, configs, and reports.",
      "Use virtual_shell for listing/searching/moving/copying/deleting files.",
      "Filesystem is persisted in Upstash Redis and scoped to the current user + session.",
      "Prefer keeping work under /workspace.",
    ],
  },
  modalities: {
    name: "modalities",
    whenToUse: "Use when the user message includes images, audio, video, or files that need staging or upload.",
    guidance: [
      "Use list_session_assets to inspect available assets.",
      "Use prepare_session_asset first for metadata and upload hints.",
      "Use asset references like asset://asset_m6_p2 when calling external tools.",
      "The tool execution wrapper resolves asset references deterministically before the external tool runs.",
      "Do not assume all Composio upload tools use the same schema.",
    ],
  },
};

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
// Redis VFS primitives
// ============================================================
async function vfsAllPaths(rt: VirtualRuntime): Promise<string[]> {
  const raw = (await rt.redis.smembers(vfsPathsKey(rt.userId, rt.sessionId))) ?? [];
  return (Array.isArray(raw) ? raw : []).map((x) => sanitizePath(String(x))).sort();
}

async function vfsGetNode(rt: VirtualRuntime, path: string): Promise<VfsNode | undefined> {
  const p = sanitizePath(path);
  const node = await rt.redis.get(vfsNodeKey(rt.userId, rt.sessionId, p));
  if (!node) return undefined;
  return node as VfsNode;
}

async function vfsPutNode(rt: VirtualRuntime, node: VfsNode): Promise<void> {
  const p = sanitizePath(node.path);
  await rt.redis.set(vfsNodeKey(rt.userId, rt.sessionId, p), { ...node, path: p });
  await rt.redis.sadd(vfsPathsKey(rt.userId, rt.sessionId), p);
}

async function vfsRemoveNode(rt: VirtualRuntime, path: string): Promise<void> {
  const p = sanitizePath(path);
  await rt.redis.del(vfsNodeKey(rt.userId, rt.sessionId, p));
  await rt.redis.srem(vfsPathsKey(rt.userId, rt.sessionId), p);
}

async function vfsEnsureDir(rt: VirtualRuntime, path: string): Promise<void> {
  const p = sanitizePath(path);
  const existing = await vfsGetNode(rt, p);

  if (existing) {
    if (existing.type !== "dir") throw new Error(`Path exists and is not a directory: ${p}`);
    return;
  }

  for (const dir of parentDirs(p)) {
    const parent = await vfsGetNode(rt, dir);
    if (!parent) {
      await vfsPutNode(rt, {
        type: "dir",
        path: dir,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    } else if (parent.type !== "dir") {
      throw new Error(`Path exists and is not a directory: ${dir}`);
    }
  }

  await vfsPutNode(rt, {
    type: "dir",
    path: p,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

async function vfsWriteFile(rt: VirtualRuntime, path: string, content: string): Promise<void> {
  const p = sanitizePath(path);

  for (const dir of parentDirs(p)) {
    await vfsEnsureDir(rt, dir);
  }

  const existing = await vfsGetNode(rt, p);
  if (existing && existing.type === "dir") {
    throw new Error(`Cannot write file over directory: ${p}`);
  }

  await vfsPutNode(rt, {
    type: "file",
    path: p,
    content,
    createdAt: existing?.type === "file" ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
  });
}

async function vfsReadFile(rt: VirtualRuntime, path: string): Promise<string> {
  const p = sanitizePath(path);
  const node = await vfsGetNode(rt, p);
  if (!node) throw new Error(`No such file: ${p}`);
  if (node.type !== "file") throw new Error(`Not a file: ${p}`);
  return node.content;
}

async function vfsList(rt: VirtualRuntime, path: string, recursive = false): Promise<string[]> {
  const p = sanitizePath(path);
  const node = await vfsGetNode(rt, p);
  if (!node) throw new Error(`No such path: ${p}`);

  const keys = await vfsAllPaths(rt);

  if (node.type === "file") return [p];

  if (!recursive) {
    return keys.filter((k) => dirname(k) === p && k !== p).sort();
  }

  return keys.filter((k) => k === p || k.startsWith(p === "/" ? "/" : `${p}/`)).sort();
}

async function vfsDelete(rt: VirtualRuntime, path: string, recursive = false): Promise<void> {
  const p = sanitizePath(path);
  const node = await vfsGetNode(rt, p);
  if (!node) throw new Error(`No such path: ${p}`);

  if (node.type === "file") {
    await vfsRemoveNode(rt, p);
    return;
  }

  const keys = await vfsAllPaths(rt);
  const children = keys.filter((k) => k !== p && k.startsWith(`${p}/`));

  if (children.length && !recursive) {
    throw new Error(`Directory not empty: ${p}`);
  }

  for (const child of children.sort((a, b) => b.length - a.length)) {
    await vfsRemoveNode(rt, child);
  }

  await vfsRemoveNode(rt, p);
}

async function vfsMove(rt: VirtualRuntime, fromPath: string, toPath: string): Promise<void> {
  const from = sanitizePath(fromPath);
  const to = sanitizePath(toPath);

  const node = await vfsGetNode(rt, from);
  if (!node) throw new Error(`No such path: ${from}`);
  if (from === "/" || from === "/workspace") throw new Error(`Refusing to move protected path: ${from}`);
  if (to.startsWith(`${from}/`)) throw new Error(`Cannot move a path into itself: ${from} -> ${to}`);

  const keys = await vfsAllPaths(rt);
  const entries = keys.filter((p) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a.length - b.length);

  if (node.type === "file") {
    await vfsWriteFile(rt, to, node.content);
    await vfsRemoveNode(rt, from);
    return;
  }

  for (const oldPath of entries) {
    const oldNode = await vfsGetNode(rt, oldPath);
    if (!oldNode) continue;

    const suffix = oldPath === from ? "" : oldPath.slice(from.length);
    const newPath = sanitizePath(`${to}${suffix}`);

    if (oldNode.type === "dir") {
      await vfsEnsureDir(rt, newPath);
    } else {
      await vfsWriteFile(rt, newPath, oldNode.content);
    }
  }

  for (const oldPath of entries.sort((a, b) => b.length - a.length)) {
    await vfsRemoveNode(rt, oldPath);
  }
}

async function vfsCopy(rt: VirtualRuntime, fromPath: string, toPath: string): Promise<void> {
  const from = sanitizePath(fromPath);
  const to = sanitizePath(toPath);

  const node = await vfsGetNode(rt, from);
  if (!node) throw new Error(`No such path: ${from}`);
  if (to.startsWith(`${from}/`)) throw new Error(`Cannot copy a path into itself: ${from} -> ${to}`);

  const keys = await vfsAllPaths(rt);
  const entries = keys.filter((p) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a.length - b.length);

  if (node.type === "file") {
    await vfsWriteFile(rt, to, node.content);
    return;
  }

  for (const oldPath of entries) {
    const oldNode = await vfsGetNode(rt, oldPath);
    if (!oldNode) continue;

    const suffix = oldPath === from ? "" : oldPath.slice(from.length);
    const newPath = sanitizePath(`${to}${suffix}`);

    if (oldNode.type === "dir") {
      await vfsEnsureDir(rt, newPath);
    } else {
      await vfsWriteFile(rt, newPath, oldNode.content);
    }
  }
}

async function vfsFind(rt: VirtualRuntime, path: string, needle: string): Promise<string[]> {
  const base = sanitizePath(path);
  const all = await vfsList(rt, base, true);
  const q = needle.toLowerCase();
  return all.filter((p) => p.toLowerCase().includes(q));
}

async function vfsGrep(
  rt: VirtualRuntime,
  path: string,
  query: string
): Promise<Array<{ path: string; line: number; text: string }>> {
  const base = sanitizePath(path);
  const all = await vfsList(rt, base, true);
  const q = query.toLowerCase();
  const out: Array<{ path: string; line: number; text: string }> = [];

  for (const p of all) {
    const node = await vfsGetNode(rt, p);
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

async function createVirtualRuntime(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  userText: string;
  history: ModelMessage[];
  sessionAssets?: SessionAsset[];
}): Promise<VirtualRuntime> {
  const redis = await getRedisClient();
  if (!redis) {
    throw new Error(
      "Upstash Redis is not configured. Set KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN."
    );
  }

  const rt: VirtualRuntime = {
    cwd: "/workspace",
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    redis,
  };

  await vfsEnsureDir(rt, "/");
  await vfsEnsureDir(rt, "/workspace");
  await vfsEnsureDir(rt, "/workspace/context");
  await vfsEnsureDir(rt, "/workspace/skills");
  await vfsEnsureDir(rt, "/workspace/assets");

  await rt.redis.set(vfsMetaKey(args.userId, args.sessionId), {
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    cwd: "/workspace",
    updatedAt: nowIso(),
  });

  await vfsWriteFile(
    rt,
    "/workspace/README.agent.txt",
    [
      "Virtual agent workspace.",
      "",
      "This filesystem is persisted in Upstash Redis and scoped to the current user + session.",
      "Use it for scratch files, reports, payloads, drafts, and analysis artifacts.",
      "",
      `sessionId=${args.sessionId}`,
      `userId=${args.userId}`,
      `channel=${args.channel}`,
      `updatedAt=${nowIso()}`,
    ].join("\n")
  );

  await vfsWriteFile(
    rt,
    "/workspace/context/request.json",
    toSafeJson({
      sessionId: args.sessionId,
      userId: args.userId,
      channel: args.channel,
      userText: truncateText(args.userText, 4000),
      historyCount: args.history.length,
      sessionAssetCount: args.sessionAssets?.length ?? 0,
      createdAt: nowIso(),
    })
  );

  await vfsWriteFile(
    rt,
    "/workspace/context/skills.index.json",
    toSafeJson({
      skills: Object.keys(INLINE_SKILLS),
    })
  );

  await vfsWriteFile(
    rt,
    "/workspace/context/session_assets.index.json",
    toSafeJson({
      assets:
        args.sessionAssets?.map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          role: asset.role,
          filename: asset.filename,
          mimeType: asset.mimeType,
          source: asset.source,
          sizeBytes: asset.sizeBytes ?? null,
          hasUrl: Boolean(asset.url),
          hasInlineData: Boolean(asset.base64 || asset.dataUrl || asset.text),
        })) ?? [],
    })
  );

  for (const skill of Object.values(INLINE_SKILLS)) {
    await vfsWriteFile(rt, `/workspace/skills/${skill.name}.md`, renderSingleSkill(skill));
  }

  return rt;
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
    "- This shell operates on the persisted Redis-backed virtual filesystem only.",
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

async function execVirtualShell(rt: VirtualRuntime, input: string) {
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
      await vfsWriteFile(rt, spec.path, spec.content);
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
        const items = await vfsList(rt, target, false);
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "tree": {
        const target = args[0] ?? rt.cwd;
        const items = await vfsList(rt, target, true);
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "cat": {
        if (!args[0]) throw new Error("cat requires a path");
        const content = await vfsReadFile(rt, args[0]);
        return { ok: true, stdout: content, stderr: "", exitCode: 0 };
      }

      case "mkdir": {
        if (!args[0]) throw new Error("mkdir requires a path");
        await vfsEnsureDir(rt, args[0]);
        return { ok: true, stdout: `Created ${sanitizePath(args[0])}`, stderr: "", exitCode: 0 };
      }

      case "rm": {
        if (!args.length) throw new Error("rm requires a path");
        const recursive = args[0] === "-r";
        const target = recursive ? args[1] : args[0];
        if (!target) throw new Error("rm requires a path");
        await vfsDelete(rt, target, recursive);
        return { ok: true, stdout: `Removed ${sanitizePath(target)}`, stderr: "", exitCode: 0 };
      }

      case "mv": {
        if (args.length < 2) throw new Error("mv requires <from> <to>");
        await vfsMove(rt, args[0], args[1]);
        return {
          ok: true,
          stdout: `Moved ${sanitizePath(args[0])} -> ${sanitizePath(args[1])}`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "cp": {
        if (args.length < 2) throw new Error("cp requires <from> <to>");
        await vfsCopy(rt, args[0], args[1]);
        return {
          ok: true,
          stdout: `Copied ${sanitizePath(args[0])} -> ${sanitizePath(args[1])}`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "find": {
        if (args.length < 2) throw new Error("find requires <path> <needle>");
        const items = await vfsFind(rt, args[0], args.slice(1).join(" "));
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "grep": {
        if (args.length < 2) throw new Error("grep requires <path> <needle>");
        const items = await vfsGrep(rt, args[0], args.slice(1).join(" "));
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
// Session asset preparation / materialization
// ============================================================
function describeSessionAsset(asset: SessionAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    role: asset.role,
    messageIndex: asset.messageIndex,
    partIndex: asset.partIndex,
    partType: asset.partType,
    filename: asset.filename,
    mimeType: asset.mimeType,
    extension: asset.extension,
    source: asset.source,
    sizeBytes: asset.sizeBytes ?? null,
    hasUrl: Boolean(asset.url),
    hasInlineData: Boolean(asset.base64 || asset.dataUrl || asset.text),
    url: asset.url ?? null,
  };
}

async function loadSessionAssetContent(
  asset: SessionAsset,
  opts?: { fetchRemote?: boolean; maxBytes?: number }
): Promise<LoadedSessionAsset> {
  const fetchRemote = opts?.fetchRemote ?? true;
  const maxBytes = Math.max(1024, opts?.maxBytes ?? parseIntOr(env("SESSION_ASSET_MAX_BYTES"), 25 * 1024 * 1024));

  if (asset.base64) {
    const textPreview = isTextualMimeType(asset.mimeType) ? tryUtf8FromBase64(asset.base64) : null;
    return {
      base64: asset.base64,
      mimeType: asset.mimeType,
      filename: asset.filename,
      sizeBytes: asset.sizeBytes ?? estimateBase64Bytes(asset.base64),
      source: asset.source,
      textPreview,
      dataUrl: asset.dataUrl ?? `data:${asset.mimeType};base64,${asset.base64}`,
    };
  }

  if (asset.dataUrl) {
    const base64 = stripDataUrlPrefix(asset.dataUrl);
    const textPreview = isTextualMimeType(asset.mimeType) ? tryUtf8FromBase64(base64) : null;
    return {
      base64,
      mimeType: asset.mimeType,
      filename: asset.filename,
      sizeBytes: asset.sizeBytes ?? estimateBase64Bytes(base64),
      source: asset.source,
      textPreview,
      dataUrl: asset.dataUrl,
    };
  }

  if (asset.text != null) {
    const base64 = Buffer.from(asset.text, "utf8").toString("base64");
    return {
      base64,
      mimeType: asset.mimeType || "text/plain",
      filename: asset.filename,
      sizeBytes: Buffer.byteLength(asset.text, "utf8"),
      source: asset.source,
      textPreview: asset.text,
      dataUrl: `data:${asset.mimeType || "text/plain"};base64,${base64}`,
    };
  }

  if (asset.url && fetchRemote) {
    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset URL (${response.status} ${response.statusText})`);
    }

    const arr = new Uint8Array(await response.arrayBuffer());
    if (arr.byteLength > maxBytes) {
      throw new Error(`Remote asset too large (${arr.byteLength} bytes > ${maxBytes} bytes)`);
    }

    const base64 = Buffer.from(arr).toString("base64");
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || asset.mimeType || "application/octet-stream";
    const textPreview = isTextualMimeType(contentType) ? Buffer.from(arr).toString("utf8") : null;

    return {
      base64,
      mimeType: contentType,
      filename: asset.filename,
      sizeBytes: arr.byteLength,
      source: "fetched_url",
      textPreview,
      dataUrl: `data:${contentType};base64,${base64}`,
    };
  }

  throw new Error(`Asset ${asset.id} does not currently have retrievable inline data or an accessible URL`);
}

async function materializeSessionAssetToVfs(
  rt: VirtualRuntime,
  asset: SessionAsset,
  opts?: { fetchRemote?: boolean; includeBase64?: boolean }
) {
  const includeBase64 = opts?.includeBase64 ?? false;
  const loaded = await loadSessionAssetContent(asset, { fetchRemote: opts?.fetchRemote ?? true });
  const assetRoot = sanitizePath(`/workspace/assets/${asset.id}`);
  const metaPath = sanitizePath(`${assetRoot}/meta.json`);
  const rawBase64Path = sanitizePath(`${assetRoot}/${asset.filename}.base64.txt`);
  const textPath = sanitizePath(`${assetRoot}/${asset.filename}.txt`);
  const infoPath = sanitizePath(`${assetRoot}/composio_payload.json`);

  await vfsEnsureDir(rt, assetRoot);

  await vfsWriteFile(
    rt,
    metaPath,
    toSafeJson({
      ...describeSessionAsset(asset),
      loadedMimeType: loaded.mimeType,
      loadedSizeBytes: loaded.sizeBytes,
      loadedSource: loaded.source,
      createdAt: nowIso(),
    })
  );

  if (includeBase64) {
    await vfsWriteFile(rt, rawBase64Path, loaded.base64);
  }

  if (loaded.textPreview != null) {
    await vfsWriteFile(rt, textPath, loaded.textPreview);
  }

  await vfsWriteFile(
    rt,
    infoPath,
    toSafeJson({
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: asset.url ?? null,
      dataUrl: includeBase64 ? loaded.dataUrl ?? null : null,
      base64Path: includeBase64 ? rawBase64Path : null,
      textPath: loaded.textPreview != null ? textPath : null,
      notes: [
        "Prefer url when a target Composio tool accepts URL-based file ingestion.",
        "Otherwise request inline content only when the target tool truly requires it.",
        "Not all Composio tools share the same schema; adapt to the declared tool input schema.",
      ],
    })
  );

  return {
    ok: true,
    assetId: asset.id,
    assetRoot,
    metaPath,
    base64Path: includeBase64 ? rawBase64Path : null,
    textPath: loaded.textPreview != null ? textPath : null,
    infoPath,
    loaded,
  };
}

function buildPreparedAssetPayload(
  asset: SessionAsset,
  opts?: {
    loaded?: LoadedSessionAsset | null;
    materialized?: {
      assetRoot: string;
      metaPath: string;
      base64Path: string | null;
      textPath: string | null;
      infoPath: string;
    } | null;
    includeInlineData?: boolean;
    signedUrl?: string | null;
  }
) {
  const loaded = opts?.loaded ?? null;
  const materialized = opts?.materialized ?? null;
  const includeInlineData = opts?.includeInlineData ?? false;
  const signedUrl = opts?.signedUrl ?? null;

  const mimeType = loaded?.mimeType ?? asset.mimeType;
  const filename = loaded?.filename ?? asset.filename;
  const sizeBytes = loaded?.sizeBytes ?? asset.sizeBytes ?? null;
  const base64 = includeInlineData ? loaded?.base64 ?? asset.base64 ?? null : null;
  const dataUrl =
    includeInlineData
      ? loaded?.dataUrl ?? asset.dataUrl ?? (base64 ? `data:${mimeType};base64,${base64}` : null)
      : null;

  return {
    asset: describeSessionAsset(asset),
    prepared: {
      filename,
      mimeType,
      sizeBytes,
      url: signedUrl ?? asset.url ?? null,
      dataUrl,
      base64,
      textPreview: includeInlineData ? loaded?.textPreview ?? asset.text ?? null : null,
    },
    composioHints: {
      commonCandidateFields: {
        filename,
        fileName: filename,
        name: filename,
        mimeType,
        mediaType: mimeType,
        contentType: mimeType,
        fileMimeType: mimeType,
        url: signedUrl ?? asset.url ?? null,
        uri: signedUrl ?? asset.url ?? null,
        dataUrl,
        contentBase64: base64,
        base64,
      },
      guidance: [
        "Inspect the target Composio tool schema first.",
        "For URL-style parameters, pass asset://<assetId> and let the execution wrapper resolve it.",
        "For inline file parameters, use asset://<assetId> or an object with assetId and the wrapper will materialize data deterministically.",
      ],
    },
    virtualPaths: materialized
      ? {
          assetRoot: materialized.assetRoot,
          metaPath: materialized.metaPath,
          base64Path: materialized.base64Path,
          textPath: materialized.textPath,
          infoPath: materialized.infoPath,
        }
      : null,
  };
}

// ============================================================
// Deterministic asset URL + tool input resolution
// ============================================================
type AssetResolutionMode = "url" | "dataUrl" | "base64" | "auto";

function getPublicBaseUrl(): string | null {
  const value =
    env("ASSET_PUBLIC_BASE_URL") ||
    env("APP_BASE_URL") ||
    env("NEXT_PUBLIC_APP_URL") ||
    env("PUBLIC_APP_URL") ||
    "";
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

function getAssetSigningSecret(): string | null {
  const v = env("ASSET_URL_SIGNING_SECRET") || env("SESSION_ASSET_SIGNING_SECRET") || "";
  return v.trim() || null;
}

function buildSignedAssetUrl(asset: SessionAsset, ttlSeconds = 900): string | null {
  const baseUrl = getPublicBaseUrl();
  const secret = getAssetSigningSecret();
  if (!baseUrl || !secret) return null;

  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
  const payload = `${asset.id}.${expiresAt}.${asset.filename}.${asset.mimeType}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");

  const url = new URL(`${baseUrl}/api/assets/${encodeURIComponent(asset.id)}`);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("filename", asset.filename);
  url.searchParams.set("mimeType", asset.mimeType);
  url.searchParams.set("sig", sig);
  return url.toString();
}

function isAssetRefString(value: string): boolean {
  return /^asset:\/\/[A-Za-z0-9._:-]+$/.test(String(value ?? "").trim());
}

function assetIdFromRef(value: string): string {
  return String(value ?? "").trim().replace(/^asset:\/\//, "");
}

function inferResolutionModeFromKey(key: string | null | undefined): AssetResolutionMode {
  const k = String(key ?? "").toLowerCase();
  if (!k) return "auto";
  if (/(^|_)(url|uri|href|link|downloadurl|sourceurl|fileurl)$/.test(k)) return "url";
  if (/(^|_)(dataurl)$/.test(k)) return "dataUrl";
  if (/(^|_)(base64|contentbase64)$/.test(k)) return "base64";
  return "auto";
}

function resolveToolObjectAssetId(input: Record<string, any>): string | null {
  const id = pickFirstDefined(
    typeof input.assetId === "string" ? input.assetId : undefined,
    typeof input.sessionAssetId === "string" ? input.sessionAssetId : undefined,
    typeof input.sourceAssetId === "string" ? input.sourceAssetId : undefined
  );
  return id ? id.trim() : null;
}

async function resolveAssetForToolExecution(args: {
  asset: SessionAsset;
  mode: AssetResolutionMode;
  fetchRemote?: boolean;
}): Promise<{
  filename: string;
  mimeType: string;
  url: string | null;
  dataUrl: string | null;
  base64: string | null;
  sizeBytes: number | null;
}> {
  const mode = args.mode;
  const asset = args.asset;

  const signedUrl = buildSignedAssetUrl(asset);

  if (mode === "url") {
    return {
      filename: asset.filename,
      mimeType: asset.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: null,
      base64: null,
      sizeBytes: asset.sizeBytes ?? null,
    };
  }

  if (mode === "base64") {
    const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
    return {
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: loaded.dataUrl ?? null,
      base64: loaded.base64,
      sizeBytes: loaded.sizeBytes,
    };
  }

  if (mode === "dataUrl") {
    const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
    return {
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: loaded.dataUrl ?? `data:${loaded.mimeType};base64,${loaded.base64}`,
      base64: loaded.base64,
      sizeBytes: loaded.sizeBytes,
    };
  }

  // auto
  if (signedUrl || asset.url) {
    return {
      filename: asset.filename,
      mimeType: asset.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: null,
      base64: null,
      sizeBytes: asset.sizeBytes ?? null,
    };
  }

  const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
  return {
    filename: loaded.filename,
    mimeType: loaded.mimeType,
    url: signedUrl ?? asset.url ?? null,
    dataUrl: loaded.dataUrl ?? `data:${loaded.mimeType};base64,${loaded.base64}`,
    base64: loaded.base64,
    sizeBytes: loaded.sizeBytes,
  };
}

async function transformToolInputAssets(
  value: unknown,
  ctx: {
    sessionAssets: SessionAsset[];
    currentKey?: string;
    fetchRemote?: boolean;
  }
): Promise<unknown> {
  // String asset ref
  if (typeof value === "string" && isAssetRefString(value)) {
    const assetId = assetIdFromRef(value);
    const asset = ctx.sessionAssets.find((x) => x.id === assetId);
    if (!asset) return value;

    const mode = inferResolutionModeFromKey(ctx.currentKey);
    const resolved = await resolveAssetForToolExecution({
      asset,
      mode,
      fetchRemote: ctx.fetchRemote ?? true,
    });

    if (mode === "base64") return resolved.base64 ?? value;
    if (mode === "dataUrl") return resolved.dataUrl ?? value;
    if (mode === "url") return resolved.url ?? resolved.dataUrl ?? value;

    return resolved.url ?? resolved.dataUrl ?? resolved.base64 ?? value;
  }

  // Arrays
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await transformToolInputAssets(item, ctx));
    }
    return out;
  }

  // Objects
  if (value && typeof value === "object") {
    const input = value as Record<string, any>;
    const objectAssetId = resolveToolObjectAssetId(input);

    // Object directive form:
    // { assetId: "asset_m6_p2", _assetMode?: "url" | "dataUrl" | "base64", ... }
    if (objectAssetId) {
      const asset = ctx.sessionAssets.find((x) => x.id === objectAssetId);
      if (!asset) return value;

      const explicitMode = String(input._assetMode ?? "").trim() as AssetResolutionMode;
      const mode: AssetResolutionMode =
        explicitMode === "url" || explicitMode === "dataUrl" || explicitMode === "base64" || explicitMode === "auto"
          ? explicitMode
          : "auto";

      const resolved = await resolveAssetForToolExecution({
        asset,
        mode,
        fetchRemote: ctx.fetchRemote ?? true,
      });

      const next: Record<string, any> = { ...input };
      delete next.assetId;
      delete next.sessionAssetId;
      delete next.sourceAssetId;
      delete next._assetMode;

      if (next.filename == null && next.fileName == null && next.name == null) {
        next.filename = resolved.filename;
      }
      if (next.mimeType == null && next.mediaType == null && next.contentType == null) {
        next.mimeType = resolved.mimeType;
      }

      const wantsUrlFields =
        "url" in next ||
        "uri" in next ||
        "href" in next ||
        "link" in next ||
        "downloadUrl" in next ||
        "sourceUrl" in next ||
        mode === "url" ||
        mode === "auto";

      if (wantsUrlFields && resolved.url) {
        if (next.url == null) next.url = resolved.url;
        if (next.uri == null) next.uri = resolved.url;
      }

      if (mode === "dataUrl" || ("dataUrl" in next && next.dataUrl == null)) {
        if (resolved.dataUrl) next.dataUrl = resolved.dataUrl;
      }

      if (
        mode === "base64" ||
        ("base64" in next && next.base64 == null) ||
        ("contentBase64" in next && next.contentBase64 == null)
      ) {
        if (resolved.base64) {
          if (next.base64 == null) next.base64 = resolved.base64;
          if (next.contentBase64 == null) next.contentBase64 = resolved.base64;
        }
      }

      const transformedEntries = await Promise.all(
        Object.entries(next).map(async ([k, v]) => [k, await transformToolInputAssets(v, { ...ctx, currentKey: k })])
      );
      return Object.fromEntries(transformedEntries);
    }

    const transformedEntries = await Promise.all(
      Object.entries(input).map(async ([k, v]) => [k, await transformToolInputAssets(v, { ...ctx, currentKey: k })])
    );
    return Object.fromEntries(transformedEntries);
  }

  return value;
}

function wrapComposioToolsWithAssetResolution(
  composioTools: ToolSet,
  deps: {
    sessionAssets: SessionAsset[];
  }
): ToolSet {
  const wrapped: Record<string, any> = {};

  for (const [toolName, toolDef] of Object.entries(composioTools as Record<string, any>)) {
    if (!toolDef || typeof toolDef !== "object" || typeof toolDef.execute !== "function") {
      wrapped[toolName] = toolDef;
      continue;
    }

    wrapped[toolName] = {
      ...toolDef,
      execute: async (input: any, ...rest: any[]) => {
        const resolvedInput = await transformToolInputAssets(input, {
          sessionAssets: deps.sessionAssets,
          fetchRemote: true,
        });
        return await toolDef.execute(resolvedInput, ...rest);
      },
    };
  }

  return wrapped as ToolSet;
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
      const exact = parsed[toolkitSlug] ?? parsed[toolkitSlug.toLowerCase()] ?? parsed[slugKey];
      if (exact) return String(exact);
    } catch {
      // ignore invalid JSON
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
        t?.connection?.authConfig?.id ?? t?.authConfig?.id ?? t?.defaultAuthConfig?.id ?? null;

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
    { callbackUrl, authConfigId: resolved.authConfigId },
    { callbackUrl, auth_config_id: resolved.authConfigId },
    { callback_url: callbackUrl, authConfigId: resolved.authConfigId },
    { callback_url: callbackUrl, auth_config_id: resolved.authConfigId },
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

  const link = String(req?.redirectUrl ?? req?.redirect_url ?? req?.url ?? req?.link ?? "");

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
      // best effort
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

  const normalizedHistory = normalizeHistory(args.history);
  const sessionAssets = collectSessionAssets(normalizedHistory);
  const userText = String(extractRecentUserText(normalizedHistory) ?? "").trim();
  const hasRichMedia = historyHasRichMedia(normalizedHistory);

  // Critical fix for the logged failure:
  // only send valid ModelMessage shapes to the model.
  const messages = sanitizeMessagesForModel(normalizedHistory);

  const virtualRuntime = await createVirtualRuntime({
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    userText,
    history: messages,
    sessionAssets,
  });

  const fastModel = env("FAST_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o-mini";
  const smartModel = env("SMART_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o";
  const forceSmart = (env("AGENT_FORCE_SMART_MODEL") ?? "true") !== "false";
  const modelName = forceSmart ? smartModel : hasRichMedia ? smartModel : fastModel;

  const temperature = Number(env("MODEL_TEMPERATURE") ?? "0.2");

  const isTelegram = args.channel === "telegram";
  const telegramStreamingEnabled =
    isTelegram && (args.showTyping ?? true) && (env("TELEGRAM_STREAMING") ?? "true") !== "false";

  const editThrottleMs = Math.max(250, Number(env("TELEGRAM_STREAM_EDIT_THROTTLE_MS") ?? 750));
  const typingIntervalMs = Math.max(1000, Number(env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
  const maxEditChars = Math.max(800, Math.min(3800, Number(env("TELEGRAM_STREAM_CHUNK_CHARS") ?? 3500)));

  let typingLoop: { stop: () => void } | null = null;
  let placeholderMsgId: number | null = null;

  // ============================================================
  // Native tools
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
      return { ok: true, output: truncateText(output, 5000) };
    },
  });

  const connectToolkit = tool({
    description:
      "Generate a Composio connect/authorize link for a toolkit using the current user's namespace. Accepts user-friendly names like 'Typeform', 'Google Drive', or 'X'.",
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
    description: "Read a specific inline skill by name.",
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
    description: "Read a file from the Redis-backed virtual filesystem. Prefer paths under /workspace.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
      })
    ),
    execute: async (input: { path: string }) => {
      try {
        const content = await vfsReadFile(virtualRuntime, input.path);
        return {
          ok: true,
          path: sanitizePath(input.path),
          content: truncateText(content, 30000),
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
    description: "Write content to a file in the Redis-backed virtual filesystem. Prefer /workspace paths.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
        content: z.string().max(120_000),
      })
    ),
    execute: async (input: { path: string; content: string }) => {
      try {
        await vfsWriteFile(virtualRuntime, input.path, input.content);
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
      "Run shell-like commands against the Redis-backed virtual filesystem only. Supports pwd, ls, tree, cat, mkdir, write, rm, mv, cp, find, and grep.",
    inputSchema: zodSchema(
      z.object({
        command: z.string().min(1).max(120000),
      })
    ),
    execute: async (input: { command: string }) => {
      const result = await execVirtualShell(virtualRuntime, input.command);
      return {
        ok: result.ok,
        command: truncateText(input.command, 500),
        stdout: truncateText(result.stdout, 5000),
        stderr: truncateText(result.stderr, 2000),
        exitCode: result.exitCode,
      };
    },
  });

  const listSessionAssets = tool({
    description:
      "List images, audio, video, and files detected in the current conversation history, including canonical IDs for follow-up asset preparation.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      return {
        ok: true,
        count: sessionAssets.length,
        assets: sessionAssets.map((asset) => ({
          ...describeSessionAsset(asset),
          ref: `asset://${asset.id}`,
        })),
      };
    },
  });

  const prepareSessionAsset = tool({
    description:
      "Prepare a session asset for external tool usage. By default returns metadata and upload hints only. Set includeInlineData=true only when the target tool truly needs inline content.",
    inputSchema: zodSchema(
      z.object({
        assetId: z.string().min(1),
        fetchRemote: z.boolean().optional(),
        includeInlineData: z.boolean().optional(),
        materializeToVfs: z.boolean().optional(),
      })
    ),
    execute: async (input: {
      assetId: string;
      fetchRemote?: boolean;
      includeInlineData?: boolean;
      materializeToVfs?: boolean;
    }) => {
      const asset = sessionAssets.find((x) => x.id === input.assetId);
      if (!asset) {
        return {
          ok: false,
          error: `Unknown assetId "${input.assetId}"`,
          availableAssetIds: sessionAssets.map((x) => x.id),
        };
      }

      const includeInlineData = input.includeInlineData ?? false;
      const fetchRemote = input.fetchRemote ?? true;

      let loaded: LoadedSessionAsset | null = null;
      let materialized:
        | {
            assetRoot: string;
            metaPath: string;
            base64Path: string | null;
            textPath: string | null;
            infoPath: string;
          }
        | null = null;

      try {
        if (includeInlineData || input.materializeToVfs) {
          loaded = await loadSessionAssetContent(asset, { fetchRemote });
        }

        if (input.materializeToVfs) {
          const result = await materializeSessionAssetToVfs(virtualRuntime, asset, {
            fetchRemote,
            includeBase64: includeInlineData,
          });
          materialized = {
            assetRoot: result.assetRoot,
            metaPath: result.metaPath,
            base64Path: result.base64Path,
            textPath: result.textPath,
            infoPath: result.infoPath,
          };
          loaded = result.loaded;
        }

        return {
          ok: true,
          ref: `asset://${asset.id}`,
          ...buildPreparedAssetPayload(asset, {
            loaded,
            materialized,
            includeInlineData,
            signedUrl: buildSignedAssetUrl(asset),
          }),
        };
      } catch (error: any) {
        return {
          ok: false,
          asset: describeSessionAsset(asset),
          error: String(error?.message ?? error ?? "Unknown prepare_session_asset error"),
        };
      }
    },
  });

  const materializeSessionAsset = tool({
    description:
      "Persist a session asset into the Redis-backed virtual filesystem under /workspace/assets/<asset-id>/. Does not include base64 unless explicitly requested.",
    inputSchema: zodSchema(
      z.object({
        assetId: z.string().min(1),
        fetchRemote: z.boolean().optional(),
        includeBase64: z.boolean().optional(),
      })
    ),
    execute: async (input: { assetId: string; fetchRemote?: boolean; includeBase64?: boolean }) => {
      const asset = sessionAssets.find((x) => x.id === input.assetId);
      if (!asset) {
        return {
          ok: false,
          error: `Unknown assetId "${input.assetId}"`,
          availableAssetIds: sessionAssets.map((x) => x.id),
        };
      }

      try {
        const result = await materializeSessionAssetToVfs(virtualRuntime, asset, {
          fetchRemote: input.fetchRemote ?? true,
          includeBase64: input.includeBase64 ?? false,
        });

        return {
          ok: true,
          asset: describeSessionAsset(asset),
          ref: `asset://${asset.id}`,
          assetRoot: result.assetRoot,
          metaPath: result.metaPath,
          base64Path: result.base64Path,
          textPath: result.textPath,
          infoPath: result.infoPath,
          loaded: {
            filename: result.loaded.filename,
            mimeType: result.loaded.mimeType,
            sizeBytes: result.loaded.sizeBytes,
            source: result.loaded.source,
          },
        };
      } catch (error: any) {
        return {
          ok: false,
          asset: describeSessionAsset(asset),
          error: String(error?.message ?? error ?? "Unknown materialize_session_asset error"),
        };
      }
    },
  });

  // ============================================================
  // Fast-path /ssh
  // ============================================================
  const slash = parseSlashCommand(userText);
  if (slash?.cmd === "/ssh") {
    const cmd = slash.arg;
    const out = cmd ? await sshExec(cmd) : "Usage: /ssh <command>";
    return { text: String(out), responseMessages: [] as any[] };
  }

  // ============================================================
  // Load Composio tools and wrap them with deterministic asset resolution
  // ============================================================
  let composioTools: ToolSet = {};
  if (env("COMPOSIO_API_KEY")) {
    const rawTools = await getComposioToolsForUser(args.userId).catch(() => ({} as ToolSet));
    composioTools = wrapComposioToolsWithAssetResolution(rawTools, {
      sessionAssets,
    });
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
    list_session_assets: listSessionAssets,
    prepare_session_asset: prepareSessionAsset,
    materialize_session_asset: materializeSessionAsset,
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
    "You are an Agentic Operating System assistant running in Telegram/WhatsApp/SMS with Composio tools.",
    "",
    "CRITICAL TOOL RULES:",
    "- If the user asks for an external action, use the appropriate tool.",
    "- Never claim an action succeeded unless a tool call returned success.",
    "- If an action requires toolkit auth, call connect_toolkit and provide the link.",
    "- If you're unsure what is connected, call list_connections.",
    "- If you need to resolve toolkit/auth config, call resolve_toolkit_connection.",
    "",
    "COMPOSIO NAMESPACE:",
    `- Active namespace: ${args.userId}`,
    "",
    "FILESYSTEM:",
    "- Use read_virtual_file and write_virtual_file for the Redis-backed virtual filesystem.",
    "- Use virtual_shell for shell-like operations on the virtual filesystem only.",
    "- Prefer /workspace for drafts, payloads, notes, JSON, and staging.",
    "",
    "MODALITIES:",
    `- Session asset count available via tools: ${sessionAssets.length}`,
    "- Use list_session_assets to inspect assets.",
    "- Use prepare_session_asset first for metadata and upload hints.",
    "- When calling external tools, pass asset references like asset://asset_m6_p2.",
    "- The execution wrapper resolves asset references deterministically before the external tool runs.",
    "- Only request inline content when the target tool really needs it.",
    "",
    "SSH:",
    "- Use ssh_exec only for real host actions the user wants.",
    "- If blocked, tell the user to use /ssh <command>.",
    "",
    "SKILLS:",
    "- Use list_skills or read_skill only when needed.",
    "",
    `Mode: ${autonomy}`,
    "Be concise, accurate, and tool-grounded.",
  ].join("\n");

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
        stopWhen: stepCountIs(11),
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
      stopWhen: stepCountIs(11),
    });

    return { text: r.text, responseMessages: (r.response?.messages as any[]) ?? [] };
  } finally {
    typingLoop?.stop();
  }
}
