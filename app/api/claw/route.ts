import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { inboundHook, sessionWorkflow } from "@/app/workflows/session";
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
function jsonOk(extra: any = {}) {
  return NextResponse.json({ ok: true, ...extra });
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
const MEDIA_ALLOWED_HOSTS = new Set([
  "cdn-bobbyapproved.flavcity.com",
]);

function safeDecodeMediaUrlParam(raw: string): string {
  // Supports either plain URL-encoded or base64url-encoded.
  // Prefer base64url to avoid query escaping issues.
  // - If it looks like a URL, return it.
  // - Else try base64url decode.
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;

    // base64url decode
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const decoded = Buffer.from(b64 + pad, "base64").toString("utf8");
    return decoded;
  } catch {
    return raw;
  }
}

// ============================================================
// Pairing
// ============================================================
async function maybeHandleChatPairingCommand(msg: InboundMessage): Promise<boolean> {
  // Optional serverless pairing flow (KV allowlist) for chat surfaces.
  // Disabled when an env allowlist is configured for that channel.
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
  const token = `sess:${msg.sessionId}`;
  try {
    await inboundHook.resume(token, msg);
  } catch {
    await start(sessionWorkflow, [msg.sessionId, msg]);
  }
}

// ============================================================
// Inbound handling
// ============================================================
async function handleInbound(msg: InboundMessage): Promise<void> {
  // Optional chat pairing command (KV allowlist). Always handled early.
  if (await maybeHandleChatPairingCommand(msg)) return;

  // HARD /stop + /start at ingress (no LLM; no workflow)
  {
    const store = getStore();
    const key = stopKey(msg.channel, msg.sessionId);

    if (isStopCmd(msg.text)) {
      await store.set(key, "1", { exSeconds: 60 * 60 * 24 * 365 }); // 1 year
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: "✅ Stopped. Send /start to resume.",
      });
      return;
    }

    if (isStartCmd(msg.text)) {
      // No DEL in some KV APIs; overwrite short TTL
      await store.set(key, "0", { exSeconds: 5 });
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: "✅ Resumed.",
      });
      return;
    }

    const stopped = await store.get(key);
    if (stopped === "1") {
      // Silent ignore while stopped
      return;
    }
  }

  // Gate access: env allowlist (if set) OR KV pairing allowlist (if env allowlist absent)
  const allowed = await isInboundAllowed(msg);

  // Persist session metadata; only mark "last session" pointers if allowed.
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
    // If env allowlist is configured, guide the operator. Otherwise offer pairing.
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
          ? `Set TELEGRAM_ALLOWED_USERS to include: ${msg.senderId}${msg.senderUsername ? ` or @${msg.senderUsername}` : ""}`
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

    // No env allowlist configured → offer KV pairing
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

  if (op === "health") {
    return jsonOk({ ts: Date.now() });
  }

  if (op === "whatsapp") {
    const v = whatsappVerifyChallenge(url);
    if (v.ok) return new Response(v.challenge ?? "", { status: 200 });
    return new Response("Verification failed", { status: 403 });
  }

  // ✅ Media proxy:
  // GET ?op=media&url=<urlencoded-or-base64url>
  // - Downloads from Bobby CDN server-side
  // - Streams back to client (Telegram can use this URL as the photo source)
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

    // Download and stream
    const res = await fetch(u.toString(), { method: "GET" });
    if (!res.ok) return new Response(`Upstream error: ${res.status}`, { status: 502 });

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";

    // Cache aggressively (CDN already caches; this keeps your edge warm)
    const headers = new Headers();
    headers.set("content-type", contentType);
    headers.set("cache-control", "public, max-age=31536000, immutable");

    // If you want, also forward etag/last-modified
    const etag = res.headers.get("etag");
    if (etag) headers.set("etag", etag);
    const lastMod = res.headers.get("last-modified");
    if (lastMod) headers.set("last-modified", lastMod);

    return new Response(res.body, { status: 200, headers });
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
    // Watchdog: Vercel Cron can only run at minute granularity.
    // We use it to ensure a short-lived daemon workflow is running, which internally ticks every 1s.
    const store = getStore();
    const lockKey = "daemon:lock";
    const acquired = await store.set(lockKey, String(Date.now()), { exSeconds: 70, nx: true });

    if (acquired) {
      await start(daemonWorkflow, []);
      return jsonOk({ started: true, acquiredLock: true });
    }

    return jsonOk({ started: false, acquiredLock: false });
  }

  if (op === "pair") {
    // ZeroClaw-style pairing exchange: POST /pair with header X-Pairing-Code
    // Returns a bearer token used by /webhook.
    await ensurePairingCode();

    const code = req.headers.get("x-pairing-code") ?? "";
    if (!code) return new Response("Missing X-Pairing-Code header", { status: 401 });

    const token = await exchangePairingCode(code);
    if (!token) return new Response("Invalid pairing code", { status: 401 });

    return jsonOk({ token });
  }

  if (op === "webhook") {
    // ZeroClaw-style webhook ingress: requires bearer token.
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

    // Resolve delivery target:
    let target: { channel: Channel; sessionId: string } | null = null;

    if (requestedSessionId) {
      const meta = await getSessionMeta(requestedSessionId);
      if (meta) target = { channel: meta.channel, sessionId: meta.sessionId };
    } else if (channel === "last") {
      target = await getLastSession("any");
    } else if (channel === "telegram" || channel === "whatsapp" || channel === "sms") {
      target = await getLastSession(channel);
    }

    if (!deliver) {
      return new Response(null, { status: 202 });
    }

    if (!target) {
      return new Response("No active chat session to deliver to", { status: 409 });
    }

    const meta = await getSessionMeta(target.sessionId);
    if (!meta) {
      return new Response("Missing session metadata", { status: 409 });
    }

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
    if (!(await telegramValidateWebhook(req))) {
      return new Response("Unauthorized", { status: 401 });
    }
    const update = await req.json().catch(() => null);
    const updateId = (update as any)?.update_id;
if (typeof updateId === "number") {
  const store = getStore();
  const key = `dedupe:telegram:update:${updateId}`;
  const inserted = await store.set(key, "1", { exSeconds: 600, nx: true });
  if (!inserted) return jsonOk({ deduped: true });
}
    if (!update) return new Response("Bad JSON", { status: 400 });
    const msg = await normalizeTelegram(update);
    if (msg) await handleInbound(msg);
    return jsonOk();
  }

  if (op === "sms") {
    // Textbelt reply webhook: application/json with signature headers.
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

  if (!ok) {
    return new Response("Invalid Textbelt signature", { status: 401 });
  }
}


    const body = JSON.parse(raw);
    const msg = normalizeTextbeltReply(body);
    if (msg) await handleInbound(msg);
    return jsonOk();
  }

  if (op === "whatsapp") {
    const raw = await req.text();
    const sig = req.headers.get("x-hub-signature-256");
    if (!verifyWhatsAppSignature(raw, sig)) {
      return new Response("Invalid signature", { status: 401 });
    }
    const body = JSON.parse(raw);

    const messages = normalizeWhatsApp(body);
    for (const m of messages) {
      await handleInbound(m);
    }
    return jsonOk();
  }

  return new Response("Not found", { status: 404 });
}
