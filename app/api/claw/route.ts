import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { sessionWorkflow } from "@/app/workflows/session";
import { daemonWorkflow } from "@/app/workflows/daemon";

import type { Channel } from "@/app/lib/identity";
import { makeIdentity } from "@/app/lib/identity";
import { createPairing, approvePairing, getPendingCode } from "@/app/lib/pairing";
import {
  parsePairCommand,
  normalizeTelegram,
  normalizeTextbeltReply,
  normalizeWhatsApp,
  type InboundMessage,
} from "@/app/lib/normalize";
import { sendOutboundRuntime } from "@/app/lib/outbound";
import { env } from "@/app/lib/env";
import { getStore } from "@/app/lib/store";
import { telegramValidateWebhook } from "@/app/lib/providers/telegram";
import { whatsappVerifyChallenge, verifyWhatsAppSignature } from "@/app/lib/providers/whatsapp";
import {
  getTextbeltApiKeyOptional,
  shouldVerifyTextbeltWebhook,
  verifyTextbeltWebhook,
} from "@/app/lib/providers/textbelt";
import { isInboundAllowed } from "@/app/lib/allowlist";
import { saveSessionMeta, getLastSession, getSessionMeta } from "@/app/lib/sessionMeta";
import { ensurePairingCode, exchangePairingCode, verifyGatewayBearer } from "@/app/lib/gatewayAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// Utilities
// ============================================================
function jsonOk(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...extra });
}

async function handleCronTrigger() {
  const store = getStore();
  const lockKey = "daemon:lock";
  const acquired = await store.set(lockKey, String(Date.now()), { exSeconds: 70, nx: true });

  if (acquired) {
    await start(daemonWorkflow, []);
    return jsonOk({ started: true, acquiredLock: true });
  }

  return jsonOk({ started: false, acquiredLock: false });
}

function isStopCmd(text: string) {
  const t = (text ?? "").trim().toLowerCase();
  return t === "/stop" || t === "stop";
}
function isStartCmd(text: string) {
  const t = (text ?? "").trim().toLowerCase();
  return t === "/start" || t === "start";
}
function stopKey(channel: string, sessionId: string) {
  return `chat:stopped:${channel}:${sessionId}`;
}

// Media proxy allowlist (Bobby CDN only; add more hosts if needed)
const MEDIA_ALLOWED_HOSTS = new Set(["cdn-bobbyapproved.flavcity.com"]);

function safeDecodeMediaUrlParam(raw: string): string {
  // Supports either plain URL-encoded or base64url-encoded.
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;

    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

// ============================================================
// Telegram webhook handling
// ============================================================
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getObjectProp(obj: unknown, key: string): JsonObject | null {
  if (!isJsonObject(obj)) return null;
  const value = obj[key];
  return isJsonObject(value) ? value : null;
}

function getScalarId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function getStringProp(obj: unknown, key: string): string | null {
  if (!isJsonObject(obj)) return null;
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function getNumberProp(obj: unknown, key: string): number | null {
  if (!isJsonObject(obj)) return null;
  const value = obj[key];
  return typeof value === "number" ? value : null;
}

/**
 * Keep this list in sync with Telegram's Update object and reuse it when
 * setting webhook allowed_updates from your admin/UI route if desired.
 */
const TELEGRAM_ALL_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "purchased_paid_media",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
  "managed_bot",
] as const;

type TelegramUpdateType = (typeof TELEGRAM_ALL_ALLOWED_UPDATES)[number] | "unknown";

const TELEGRAM_MESSAGEISH_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
] as const;

type TelegramMessageishUpdateType = (typeof TELEGRAM_MESSAGEISH_UPDATES)[number];

function getTelegramUpdateType(update: unknown): TelegramUpdateType {
  if (!isJsonObject(update)) return "unknown";

  for (const key of TELEGRAM_ALL_ALLOWED_UPDATES) {
    if (update[key] != null) return key;
  }

  return "unknown";
}

function isTelegramMessageishUpdateType(
  updateType: TelegramUpdateType
): updateType is TelegramMessageishUpdateType {
  return (TELEGRAM_MESSAGEISH_UPDATES as readonly string[]).includes(updateType);
}

function coerceTelegramUpdateForNormalizer(
  update: unknown,
  updateType: TelegramUpdateType
): unknown {
  if (!isJsonObject(update)) return update;

  // Preserve your current normalizeTelegram() flow without forcing changes in normalize.ts.
  if (updateType === "business_message") {
    return { ...update, message: update.business_message };
  }

  if (updateType === "edited_business_message") {
    return { ...update, edited_message: update.edited_business_message };
  }

  return update;
}

function getTelegramUpdateId(update: unknown): number | null {
  return getNumberProp(update, "update_id");
}

async function callTelegramBotApi(
  method: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    return res.ok;
  } catch {
    return false;
  }
}

async function answerTelegramCallbackQuery(callbackQueryId: string): Promise<void> {
  await callTelegramBotApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
  });
}

async function answerTelegramInlineQueryEmpty(inlineQueryId: string): Promise<void> {
  await callTelegramBotApi("answerInlineQuery", {
    inline_query_id: inlineQueryId,
    results: [],
    cache_time: 0,
    is_personal: true,
  });
}

async function rejectTelegramShippingQuery(
  shippingQueryId: string,
  errorMessage = "Shipping is not configured for this bot."
): Promise<void> {
  await callTelegramBotApi("answerShippingQuery", {
    shipping_query_id: shippingQueryId,
    ok: false,
    error_message: errorMessage,
  });
}

async function rejectTelegramPreCheckoutQuery(
  preCheckoutQueryId: string,
  errorMessage = "Payments are not configured for this bot."
): Promise<void> {
  await callTelegramBotApi("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQueryId,
    ok: false,
    error_message: errorMessage,
  });
}

function buildInboundFromTelegramCallbackQuery(update: unknown): InboundMessage | null {
  const callbackQuery = getObjectProp(update, "callback_query");
  if (!callbackQuery) return null;

  const from = getObjectProp(callbackQuery, "from");
  const senderId = getScalarId(from?.id);
  if (!senderId) return null;

  const senderUsername = getStringProp(from, "username") ?? undefined;
  const message = getObjectProp(callbackQuery, "message");
  const chat = getObjectProp(message, "chat");

  const sessionId =
    getScalarId(chat?.id) ??
    (() => {
      const inlineMessageId = getStringProp(callbackQuery, "inline_message_id");
      if (inlineMessageId) return `telegram:inline:${inlineMessageId}`;
      return `telegram:user:${senderId}`;
    })();

  const data = getStringProp(callbackQuery, "data");
  const gameShortName = getStringProp(callbackQuery, "game_short_name");
  const text = data ?? gameShortName ?? "/callback";

  return {
    channel: "telegram",
    sessionId,
    senderId,
    senderUsername,
    text,
    ts: Date.now(),
    raw: {
      source: "telegram_callback_query",
      update,
    },
  };
}

async function handleTelegramWebhook(req: Request): Promise<Response> {
  if (!(await telegramValidateWebhook(req))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await req.json().catch(() => null);
  if (!update) return new Response("Bad JSON", { status: 400 });

  const updateId = getTelegramUpdateId(update);
  if (typeof updateId === "number") {
    const store = getStore();
    const key = `dedupe:telegram:update:${updateId}`;
    const inserted = await store.set(key, "1", { exSeconds: 600, nx: true });
    if (!inserted) return jsonOk({ telegram: true, deduped: true });
  }

  const updateType = getTelegramUpdateType(update);

  // callback_query needs a fast ack so the Telegram client button spinner clears.
  if (updateType === "callback_query") {
    const callbackQuery = getObjectProp(update, "callback_query");
    const callbackQueryId = getStringProp(callbackQuery, "id");
    if (callbackQueryId) await answerTelegramCallbackQuery(callbackQueryId);

    const synthetic = buildInboundFromTelegramCallbackQuery(update);
    if (synthetic) {
      await handleInbound(synthetic);
      return jsonOk({ telegram: true, updateType, routed: true });
    }

    return jsonOk({ telegram: true, updateType, routed: false });
  }

  // Preserve your existing message/session workflow behavior.
  if (isTelegramMessageishUpdateType(updateType)) {
    const msg = await normalizeTelegram(
      coerceTelegramUpdateForNormalizer(update, updateType)
    );
    if (msg) await handleInbound(msg);
    return jsonOk({ telegram: true, updateType, routed: Boolean(msg) });
  }

  // Safe, explicit handling for webhook event families that otherwise hang or fall through.
  if (updateType === "inline_query") {
    const inlineQuery = getObjectProp(update, "inline_query");
    const inlineQueryId = getStringProp(inlineQuery, "id");
    if (inlineQueryId) await answerTelegramInlineQueryEmpty(inlineQueryId);
    return jsonOk({ telegram: true, updateType, routed: false });
  }

  if (updateType === "shipping_query") {
    const shippingQuery = getObjectProp(update, "shipping_query");
    const shippingQueryId = getStringProp(shippingQuery, "id");
    if (shippingQueryId) await rejectTelegramShippingQuery(shippingQueryId);
    return jsonOk({ telegram: true, updateType, routed: false });
  }

  if (updateType === "pre_checkout_query") {
    const preCheckoutQuery = getObjectProp(update, "pre_checkout_query");
    const preCheckoutQueryId = getStringProp(preCheckoutQuery, "id");
    if (preCheckoutQueryId) await rejectTelegramPreCheckoutQuery(preCheckoutQueryId);
    return jsonOk({ telegram: true, updateType, routed: false });
  }

  // The rest of Telegram's Update types are now explicitly classified and acknowledged.
  return jsonOk({ telegram: true, updateType, routed: false });
}

// ============================================================
// Pairing
// ============================================================
async function maybeHandleChatPairingCommand(msg: InboundMessage): Promise<boolean> {
  const envAllowConfigured =
    (msg.channel === "telegram" && process.env.TELEGRAM_ALLOWED_USERS != null) ||
    (msg.channel === "whatsapp" && process.env.WHATSAPP_ALLOWED_NUMBERS != null) ||
    (msg.channel === "sms" && process.env.SMS_ALLOWED_NUMBERS != null);
  if (envAllowConfigured) return false;

  const cmd = parsePairCommand(msg.text);
  if (!cmd) return false;

  const identity = makeIdentity(msg.channel, msg.senderId);

  if (!cmd.code) {
    const pending = await getPendingCode(identity);
    if (pending) {
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: `Pending pairing code: ${pending}\nReply with /pair ${pending}`,
      });
    } else {
      const code = await createPairing(identity);
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: `Pairing code: ${code}\nReply with /pair ${code}`,
      });
    }
    return true;
  }

  const ok = await approvePairing(identity, cmd.code);
  await sendOutboundRuntime({
    channel: msg.channel,
    sessionId: msg.sessionId,
    text: ok ? "✅ Paired. You can now use the bot." : "❌ Invalid or expired pairing code.",
  });
  return true;
}

// ============================================================
// Workflow routing
// ============================================================
async function routeToSession(msg: InboundMessage): Promise<void> {
  await start(sessionWorkflow, [msg.sessionId, msg]);
}

// ============================================================
// Inbound handling
// ============================================================
async function handleInbound(msg: InboundMessage): Promise<void> {
  if (await maybeHandleChatPairingCommand(msg)) return;

  // HARD /stop + /start at ingress (no LLM; no workflow)
  {
    const store = getStore();
    const key = stopKey(msg.channel, msg.sessionId);

    if (isStopCmd(msg.text)) {
      await store.set(key, "1", { exSeconds: 60 * 60 * 24 * 365 });
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: "✅ Stopped. Send /start to resume.",
      });
      return;
    }

    if (isStartCmd(msg.text)) {
      await store.set(key, "0", { exSeconds: 5 });
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: "✅ Resumed.",
      });
      return;
    }

    const stopped = await store.get(key);
    if (stopped === "1") return;
  }

  const allowed = await isInboundAllowed(msg);

  await saveSessionMeta(
    {
      channel: msg.channel,
      sessionId: msg.sessionId,
      senderId: msg.senderId,
      senderUsername: msg.senderUsername,
      updatedAt: Date.now(),
    },
    { updateLast: allowed.allowed }
  );

  if (!allowed.allowed) {
    const hasTelegramAllow = process.env.TELEGRAM_ALLOWED_USERS != null;
    const hasWhatsAllow = process.env.WHATSAPP_ALLOWED_NUMBERS != null;
    const hasSmsAllow = process.env.SMS_ALLOWED_NUMBERS != null;

    const identity = makeIdentity(msg.channel, msg.senderId);

    if (
      (msg.channel === "telegram" && hasTelegramAllow) ||
      (msg.channel === "whatsapp" && hasWhatsAllow) ||
      (msg.channel === "sms" && hasSmsAllow)
    ) {
      const hint =
        msg.channel === "telegram"
          ? `Set TELEGRAM_ALLOWED_USERS to include: ${msg.senderId}${
              msg.senderUsername ? ` or @${msg.senderUsername}` : ""
            }`
          : msg.channel === "whatsapp"
            ? `Set WHATSAPP_ALLOWED_NUMBERS to include: ${msg.senderId} (E.164)`
            : `Set SMS_ALLOWED_NUMBERS to include: ${msg.senderId} (E.164)`;

      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: `🔒 Unauthorized (${allowed.reason ?? "not allowed"}).\nIdentity: ${identity}\n\nOperator hint: ${hint}`,
      });
      return;
    }

    const pending = await getPendingCode(identity);
    const code = pending ?? (await createPairing(identity));
    await sendOutboundRuntime({
      channel: msg.channel,
      sessionId: msg.sessionId,
      text:
        `🔒 This bot is locked.\n` +
        `Reply with: /pair ${code}\n` +
        `This code expires in 15 minutes.`,
    });
    return;
  }

  await routeToSession(msg);
}

// ============================================================
// GET handler
// ============================================================
export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op");

  if (op === "health") return jsonOk({ ts: Date.now() });

  if (op === "cron") {
    return handleCronTrigger();
  }

  if (op === "whatsapp") {
    const v = whatsappVerifyChallenge(url);
    if (v.ok) return new Response(v.challenge ?? "", { status: 200 });
    return new Response("Verification failed", { status: 403 });
  }

  if (op === "media") {
    const raw = url.searchParams.get("url") ?? "";
    if (!raw) return new Response("Missing url param", { status: 400 });

    const decoded = safeDecodeMediaUrlParam(decodeURIComponent(raw));
    let u: URL;
    try {
      u = new URL(decoded);
    } catch {
      return new Response("Bad url", { status: 400 });
    }

    if (!MEDIA_ALLOWED_HOSTS.has(u.host)) {
      return new Response("Host not allowed", { status: 403 });
    }

    const res = await fetch(u.toString(), { method: "GET" });
    if (!res.ok) return new Response(`Upstream error: ${res.status}`, { status: 502 });

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";

    const headers = new Headers();
    headers.set("content-type", contentType);
    headers.set("cache-control", "public, max-age=31536000, immutable");

    const etag = res.headers.get("etag");
    if (etag) headers.set("etag", etag);
    const lastMod = res.headers.get("last-modified");
    if (lastMod) headers.set("last-modified", lastMod);

    return new Response(res.body, { status: 200, headers });
  }

  if (op === "webhook") {
    const ok = await verifyGatewayBearer(req);
    if (!ok) return new Response("Unauthorized", { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body) return new Response("Bad JSON", { status: 400 });

    const message = String(body.message ?? "");
    if (!message) return new Response("Missing field: message", { status: 400 });

    const deliver = body.deliver !== undefined ? Boolean(body.deliver) : true;
    const channel = String(body.channel ?? "last");
    const allowSessionOverride = env("ALLOW_WEBHOOK_SESSION_ID") === "true";
    const requestedSessionId = allowSessionOverride ? String(body.sessionId ?? "") : "";

    let target: { channel: Channel; sessionId: string } | null = null;

    if (requestedSessionId) {
      const meta = await getSessionMeta(requestedSessionId);
      if (meta) target = { channel: meta.channel, sessionId: meta.sessionId };
    } else if (channel === "last") {
      target = await getLastSession("any");
    } else if (channel === "telegram" || channel === "whatsapp" || channel === "sms") {
      target = await getLastSession(channel);
    }

    if (!deliver) return new Response(null, { status: 202 });
    if (!target) return new Response("No active chat session to deliver to", { status: 409 });

    const meta = await getSessionMeta(target.sessionId);
    if (!meta) return new Response("Missing session metadata", { status: 409 });

    const synthetic: InboundMessage = {
      channel: meta.channel,
      sessionId: meta.sessionId,
      senderId: meta.senderId,
      senderUsername: meta.senderUsername,
      text: message,
      ts: Date.now(),
      raw: { source: "webhook" },
    };

    await routeToSession(synthetic);
    return new Response(null, { status: 202 });
  }

  if (op === "telegram") {
    return handleTelegramWebhook(req);
  }

  return new Response("Not found", { status: 404 });
}

// ============================================================
// POST handler
// ============================================================
export async function POST(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op");

  if (op === "cron") {
    return handleCronTrigger();
  }

  if (op === "pair") {
    await ensurePairingCode();

    const code = req.headers.get("x-pairing-code") ?? "";
    if (!code) return new Response("Missing X-Pairing-Code header", { status: 401 });

    const token = await exchangePairingCode(code);
    if (!token) return new Response("Invalid pairing code", { status: 401 });

    return jsonOk({ token });
  }

  if (op === "webhook") {
    const ok = await verifyGatewayBearer(req);
    if (!ok) return new Response("Unauthorized", { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body) return new Response("Bad JSON", { status: 400 });

    const message = String(body.message ?? "");
    if (!message) return new Response("Missing field: message", { status: 400 });

    const deliver = body.deliver !== undefined ? Boolean(body.deliver) : true;
    const channel = String(body.channel ?? "last");
    const allowSessionOverride = env("ALLOW_WEBHOOK_SESSION_ID") === "true";
    const requestedSessionId = allowSessionOverride ? String(body.sessionId ?? "") : "";

    let target: { channel: Channel; sessionId: string } | null = null;

    if (requestedSessionId) {
      const meta = await getSessionMeta(requestedSessionId);
      if (meta) target = { channel: meta.channel, sessionId: meta.sessionId };
    } else if (channel === "last") {
      target = await getLastSession("any");
    } else if (channel === "telegram" || channel === "whatsapp" || channel === "sms") {
      target = await getLastSession(channel);
    }

    if (!deliver) return new Response(null, { status: 202 });
    if (!target) return new Response("No active chat session to deliver to", { status: 409 });

    const meta = await getSessionMeta(target.sessionId);
    if (!meta) return new Response("Missing session metadata", { status: 409 });

    const synthetic: InboundMessage = {
      channel: meta.channel,
      sessionId: meta.sessionId,
      senderId: meta.senderId,
      senderUsername: meta.senderUsername,
      text: message,
      ts: Date.now(),
      raw: { source: "webhook" },
    };

    await routeToSession(synthetic);
    return new Response(null, { status: 202 });
  }

  if (op === "telegram") {
    return handleTelegramWebhook(req);
  }

  if (op === "sms") {
    const raw = await req.text();

    const apiKey = getTextbeltApiKeyOptional();
    if (apiKey && shouldVerifyTextbeltWebhook()) {
      const sig = req.headers.get("x-textbelt-signature");
      const ts = req.headers.get("x-textbelt-timestamp");

      const ok = await verifyTextbeltWebhook({
        apiKey,
        timestampHeader: ts,
        signatureHeader: sig,
        rawBody: raw,
      });

      if (!ok) return new Response("Invalid Textbelt signature", { status: 401 });
    }

    const body = JSON.parse(raw);
    const msg = normalizeTextbeltReply(body);
    if (msg) await handleInbound(msg);
    return jsonOk();
  }

  if (op === "whatsapp") {
    const raw = await req.text();
    const sig = req.headers.get("x-hub-signature-256");

    if (!(await verifyWhatsAppSignature(raw, sig))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const body = JSON.parse(raw);
    const messages = normalizeWhatsApp(body);
    for (const m of messages) await handleInbound(m);

    return jsonOk();
  }

  return new Response("Not found", { status: 404 });
}
