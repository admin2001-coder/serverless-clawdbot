// app/lib/providers/telegram.ts
import { env, envRequired } from "@/app/lib/env";

type TelegramApiOk<T> = { ok: true; result: T };
type TelegramApiErr = { ok: false; description?: string; error_code?: number };

type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

type TelegramParseMode = "HTML";

type TelegramPreparedText = {
  html: string;
  plain: string;
  parseMode: TelegramParseMode;
};

const TELEGRAM_PARSE_MODE: TelegramParseMode = "HTML";
const TELEGRAM_SUPPORTED_HTML_ENTITY_RE = /&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/gi;
const TELEGRAM_CODE_FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;
const TELEGRAM_INLINE_CODE_RE = /`([^`\n]+)`/g;
const TELEGRAM_LOG_LINE_RE =
  /(^\s*(?:\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|\[(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]|(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|at\s+\S+\s*\(|Caused by:|Exception:|Traceback \(most recent call last\):))/i;
const TELEGRAM_ENTITY_ERROR_RE = /can't parse entities|unsupported start tag|unexpected end tag|entity name expected|tag ".*?" must be closed|bad request: can't parse/i;

const TELEGRAM_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  fish: "bash",
  console: "bash",
  ps1: "powershell",
  psql: "sql",
  yml: "yaml",
  md: "markdown",
  plaintext: "text",
  plain: "text",
  txt: "text",
  text: "text",
  logs: "log",
  log: "log",
  conf: "ini",
  cfg: "ini",
  dockerfile: "dockerfile",
  html: "html",
  xml: "xml",
  svg: "xml",
  json: "json",
  yaml: "yaml",
  sql: "sql",
  diff: "diff",
  ini: "ini",
  toml: "toml",
  rust: "rust",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kotlin: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  ruby: "ruby",
};

export function telegramSessionToChatAndThread(sessionId: string): { chatId: string; threadId?: number } {
  // sessionId: telegram:<chatId> or telegram:<chatId>:<threadId>
  const parts = String(sessionId ?? "").split(":");
  const chatId = parts[1] ?? "";
  const threadId = parts.length >= 3 ? Number(parts[2]) : undefined;
  return { chatId, threadId: Number.isFinite(threadId as any) ? threadId : undefined };
}

export async function telegramValidateWebhook(req: Request): Promise<boolean> {
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return true;
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  return got === secret;
}

function normalizeTelegramText(text: string): string {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

function escapeTelegramHtml(text: string): string {
  return normalizeTelegramText(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripSupportedEntities(text: string): string {
  return text.replace(TELEGRAM_SUPPORTED_HTML_ENTITY_RE, "X");
}

function normalizeTelegramLanguage(language?: string | null, code?: string): string | undefined {
  const raw = String(language ?? "")
    .trim()
    .toLowerCase()
    .replace(/^language-/, "")
    .replace(/[^a-z0-9#+._-]/g, "");

  if (raw) {
    return TELEGRAM_LANGUAGE_ALIASES[raw] ?? raw;
  }

  return detectTelegramCodeLanguage(code ?? "");
}

function looksLikeJsonBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return false;

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksLikeLogBlock(text: string): boolean {
  const lines = normalizeTelegramText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return false;

  const matchingLines = lines.filter((line) => TELEGRAM_LOG_LINE_RE.test(line)).length;
  return matchingLines >= Math.max(2, Math.ceil(lines.length * 0.5));
}

function looksLikeShellBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (/^#!\/.*\b(?:bash|sh|zsh|fish)\b/m.test(trimmed)) return true;

  const lines = trimmed.split("\n").map((line) => line.trim());
  const commandish = lines.filter(
    (line) =>
      /^\$\s+/.test(line) ||
      /^(?:npm|pnpm|yarn|bun|node|npx|git|curl|wget|ls|cd|cat|echo|grep|find|cp|mv|rm|mkdir|chmod|chown|docker|kubectl|ssh|scp|rsync)\b/.test(line)
  ).length;

  return commandish >= Math.max(1, Math.ceil(lines.length * 0.5));
}

function looksLikeSqlBlock(text: string): boolean {
  const trimmed = text.trim();
  return /^(?:select|insert|update|delete|create|alter|drop|with)\b/i.test(trimmed);
}

function looksLikeHtmlOrXmlBlock(text: string): boolean {
  const trimmed = text.trim();
  return /^<(?:!doctype\s+html|html|body|head|div|span|svg|\?xml|[a-z][a-z0-9:_-]*)(?:\s|>|\/)/i.test(trimmed);
}

function looksLikePythonBlock(text: string): boolean {
  return /(^|\n)\s*(?:def\s+\w+\s*\(|class\s+\w+[(:]|from\s+\S+\s+import\s+|import\s+\S+|print\s*\()/m.test(text);
}

function looksLikeTypeScriptBlock(text: string): boolean {
  return /(^|\n)\s*(?:interface\s+\w+|type\s+\w+\s*=|export\s+type\s+|export\s+interface\s+|const\s+\w+\s*:\s*\w|function\s+\w+\s*<)/m.test(text);
}

function looksLikeJavaScriptBlock(text: string): boolean {
  return /(^|\n)\s*(?:const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|function\s+\w+\s*\(|import\s+.+\s+from\s+['"]|export\s+(?:default\s+)?(?:function|const|class)|class\s+\w+|\w+\s*=>)/m.test(text);
}

function detectTelegramCodeLanguage(code: string): string | undefined {
  const text = normalizeTelegramText(code);
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (looksLikeJsonBlock(trimmed)) return "json";
  if (looksLikeLogBlock(trimmed)) return "log";
  if (looksLikeSqlBlock(trimmed)) return "sql";
  if (looksLikeHtmlOrXmlBlock(trimmed)) return /^<\?xml|^<svg\b/i.test(trimmed) ? "xml" : "html";
  if (looksLikeShellBlock(trimmed)) return "bash";
  if (looksLikePythonBlock(trimmed)) return "python";
  if (looksLikeTypeScriptBlock(trimmed)) return "typescript";
  if (looksLikeJavaScriptBlock(trimmed)) return "javascript";
  if (/^\s*---\s*$/m.test(trimmed) || /^\s*[A-Za-z0-9_.-]+\s*:\s*.+$/m.test(trimmed)) return "yaml";

  return undefined;
}

function shouldRenderEntireMessageAsCodeBlock(text: string): boolean {
  const normalized = normalizeTelegramText(text);
  const trimmed = normalized.trim();
  if (!trimmed) return false;
  if (trimmed.includes("```") || trimmed.includes("<pre") || trimmed.includes("<code")) return false;

  if (looksLikeJsonBlock(trimmed) || looksLikeLogBlock(trimmed)) return true;

  const lines = trimmed.split("\n");
  if (lines.length < 2) return false;

  return Boolean(detectTelegramCodeLanguage(trimmed));
}

function renderInlineCodeHtml(text: string): string {
  const normalized = normalizeTelegramText(text);
  let out = "";
  let lastIndex = 0;

  for (const match of normalized.matchAll(TELEGRAM_INLINE_CODE_RE)) {
    const index = match.index ?? 0;
    out += escapeTelegramHtml(normalized.slice(lastIndex, index));
    out += `<code>${escapeTelegramHtml(match[1] ?? "")}</code>`;
    lastIndex = index + match[0].length;
  }

  out += escapeTelegramHtml(normalized.slice(lastIndex));
  return out;
}

function renderCodeBlockHtml(code: string, language?: string | null): string {
  const normalizedCode = normalizeTelegramText(code).replace(/^\n/, "").replace(/\n$/, "");
  const escaped = escapeTelegramHtml(normalizedCode);
  const normalizedLanguage = normalizeTelegramLanguage(language, normalizedCode);

  if (normalizedLanguage) {
    return `<pre><code class="language-${normalizedLanguage}">${escaped}</code></pre>`;
  }

  return `<pre><code>${escaped}</code></pre>`;
}

function convertMarkdownFencesToTelegramHtml(text: string): string {
  const normalized = normalizeTelegramText(text);

  if (!normalized.includes("```")) {
    if (shouldRenderEntireMessageAsCodeBlock(normalized)) {
      return renderCodeBlockHtml(normalized, undefined);
    }
    return renderInlineCodeHtml(normalized);
  }

  const fenceCount = normalized.match(/```/g)?.length ?? 0;
  if (fenceCount % 2 !== 0) {
    return renderInlineCodeHtml(normalized);
  }

  let out = "";
  let lastIndex = 0;
  let matchedFence = false;

  for (const match of normalized.matchAll(TELEGRAM_CODE_FENCE_RE)) {
    matchedFence = true;
    const index = match.index ?? 0;
    out += renderInlineCodeHtml(normalized.slice(lastIndex, index));
    out += renderCodeBlockHtml(match[2] ?? "", match[1] ?? "");
    lastIndex = index + match[0].length;
  }

  if (!matchedFence) {
    return renderInlineCodeHtml(normalized);
  }

  out += renderInlineCodeHtml(normalized.slice(lastIndex));
  return out;
}

export function telegramFormatMessageHtml(text: string): TelegramPreparedText {
  const plain = normalizeTelegramText(text ?? "") || "…";
  const html = convertMarkdownFencesToTelegramHtml(plain) || "…";
  return {
    html,
    plain,
    parseMode: TELEGRAM_PARSE_MODE,
  };
}

function shouldRetryWithoutHtml(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return TELEGRAM_ENTITY_ERROR_RE.test(message);
}

async function telegramApiCall<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const token = envRequired("TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();

  let parsed: TelegramApiOk<T> | TelegramApiErr | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ignore
  }

  if (parsed && (parsed as any).ok === false) {
    const err = parsed as TelegramApiErr;
    const code = err.error_code ?? res.status;
    const desc = err.description ?? raw;
    throw new Error(`Telegram ${method} failed: ${code} ${desc}`);
  }

  if (!res.ok) throw new Error(`Telegram ${method} HTTP ${res.status}: ${raw}`);
  if (!parsed || (parsed as any).ok !== true) throw new Error(`Telegram ${method} bad response: ${raw}`);

  return (parsed as TelegramApiOk<T>).result;
}

export async function telegramSendChatAction(sessionId: string, action: TelegramChatAction): Promise<void> {
  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const payload: any = { chat_id: chatId, action };
  if (threadId) payload.message_thread_id = threadId;

  await telegramApiCall("sendChatAction", payload);
}

export function telegramStartChatActionLoop(
  sessionId: string,
  action: TelegramChatAction,
  opts?: { intervalMs?: number }
): { stop: () => void } {
  const intervalMs = Math.max(1000, Number(opts?.intervalMs ?? env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
  let stopped = false;

  (async () => {
    while (!stopped) {
      try {
        await telegramSendChatAction(sessionId, action);
      } catch {
        // best-effort
      }
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  })();

  return { stop: () => (stopped = true) };
}

export async function telegramSendMessage(
  sessionId: string,
  text: string,
  opts?: { disableWebPreview?: boolean; disableNotification?: boolean }
): Promise<number> {
  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const prepared = telegramFormatMessageHtml(text ?? "");
  const payload: any = {
    chat_id: chatId,
    text: prepared.html,
    parse_mode: prepared.parseMode,
    disable_web_page_preview: opts?.disableWebPreview ?? true,
    disable_notification: opts?.disableNotification ?? false,
  };
  if (threadId) payload.message_thread_id = threadId;

  try {
    const result = await telegramApiCall<{ message_id: number }>("sendMessage", payload);
    return result.message_id;
  } catch (error) {
    if (!shouldRetryWithoutHtml(error)) throw error;

    const fallbackPayload: any = {
      ...payload,
      text: prepared.plain,
    };
    delete fallbackPayload.parse_mode;

    const result = await telegramApiCall<{ message_id: number }>("sendMessage", fallbackPayload);
    return result.message_id;
  }
}

export async function telegramEditMessageText(
  sessionId: string,
  messageId: number,
  text: string,
  opts?: { disableWebPreview?: boolean }
): Promise<void> {
  const { chatId, threadId } = telegramSessionToChatAndThread(sessionId);
  if (!chatId) throw new Error(`Invalid telegram sessionId: ${sessionId}`);

  const prepared = telegramFormatMessageHtml(text ?? "");
  const payload: any = {
    chat_id: chatId,
    message_id: messageId,
    text: prepared.html,
    parse_mode: prepared.parseMode,
    disable_web_page_preview: opts?.disableWebPreview ?? true,
  };
  if (threadId) payload.message_thread_id = threadId;

  try {
    await telegramApiCall("editMessageText", payload);
  } catch (error: any) {
    const msg = String(error?.message ?? "");
    if (msg.includes("message is not modified")) return;

    if (shouldRetryWithoutHtml(error)) {
      const fallbackPayload: any = {
        ...payload,
        text: prepared.plain,
      };
      delete fallbackPayload.parse_mode;

      try {
        await telegramApiCall("editMessageText", fallbackPayload);
        return;
      } catch (fallbackError: any) {
        const fallbackMsg = String(fallbackError?.message ?? "");
        if (fallbackMsg.includes("message is not modified")) return;
        throw fallbackError;
      }
    }

    throw error;
  }
}
