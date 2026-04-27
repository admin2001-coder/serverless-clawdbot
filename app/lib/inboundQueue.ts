import type { InboundMessage } from "@/app/lib/normalize";
import { getStore } from "@/app/lib/store";
import { safeKeyPart, shortHash, stableStringify } from "@/app/lib/hash";

export type QueuedInboundMessage = InboundMessage & {
  inboundId: string;
  receivedAt: number;
  dedupeKey: string;
};

export type LogicalUserInput = {
  id: string;
  text: string;
  sourceInboundIds: string[];
  relation: "single" | "joined_fragments" | "separate_intent" | "fallback";
  confidence: number;
};

export type PendingSessionSnapshot = {
  pending: number;
  ready: boolean;
  waitMs: number;
  oldestReceivedAt?: number;
  newestReceivedAt?: number;
};

const DATA_HASH = "inbound:data";
const PROCESSING_HASH = "inbound:processing";
const PROCESSING_INDEX = "inbound:processing:index";
const SESSION_INDEX = "inbound:sessions";

function pendingZKey(sessionId: string) {
  return `inbound:pending:${sessionId}`;
}

function dedupeTtlSeconds(): number {
  const n = Number(process.env.INBOUND_DEDUPE_TTL_SECONDS ?? 60 * 60 * 24 * 14);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60 * 60 * 24 * 14;
}

function processingLeaseMs(): number {
  const n = Number(process.env.INBOUND_PROCESSING_LEASE_MS ?? 10 * 60 * 1000);
  return Number.isFinite(n) && n > 1000 ? Math.floor(n) : 10 * 60 * 1000;
}

function sessionProcessorTtlSeconds(): number {
  const n = Number(process.env.SESSION_PROCESSOR_LOCK_SECONDS ?? 900);
  return Number.isFinite(n) && n >= 30 ? Math.ceil(n) : 900;
}

function coalesceQuietMs(): number {
  const n = Number(process.env.MESSAGE_COHERENCE_WINDOW_MS ?? 2200);
  return Number.isFinite(n) ? Math.max(250, Math.min(15_000, Math.floor(n))) : 2200;
}

function getRaw(obj: unknown): any {
  return obj && typeof obj === "object" ? obj : {};
}

export function getInboundProviderMessageId(msg: InboundMessage): string {
  const raw = getRaw(msg.raw);
  const r = getRaw(raw.raw ?? raw);
  const telegramMessage =
    r.message ?? r.edited_message ?? r.business_message ?? r.channel_post ?? r.edited_channel_post ?? null;

  if (msg.channel === "telegram") {
    const updateId = r.update_id ?? raw.update_id;
    const messageId = telegramMessage?.message_id ?? raw.message_id;
    if (updateId != null || messageId != null) {
      return `telegram:${updateId ?? "no-update"}:${messageId ?? "no-message"}`;
    }
  }

  if (msg.channel === "whatsapp") {
    const id = raw.id ?? raw.message_id ?? raw.messages?.[0]?.id;
    if (id) return `whatsapp:${id}`;
  }

  if (msg.channel === "sms") {
    const id = raw.textId ?? raw.messageId ?? raw.id;
    if (id) return `sms:${id}`;
  }

  const tsBucket = Math.floor(Number(msg.ts || Date.now()) / 30_000);
  return `${msg.channel}:${msg.sessionId}:${msg.senderId}:${tsBucket}:${shortHash(msg.text, 24)}`;
}

export function buildInboundDedupeKey(msg: InboundMessage): string {
  return safeKeyPart(getInboundProviderMessageId(msg), 220);
}

export function buildInboundId(msg: InboundMessage): string {
  return shortHash({
    providerMessageId: getInboundProviderMessageId(msg),
    channel: msg.channel,
    sessionId: msg.sessionId,
    senderId: msg.senderId,
    text: msg.text,
    ts: msg.ts,
  }, 32);
}

export async function enqueueInboundMessage(msg: InboundMessage): Promise<{
  accepted: boolean;
  inboundId: string;
  dedupeKey: string;
  sessionId: string;
  reason: "queued" | "duplicate";
}> {
  const store = getStore();
  const inboundId = buildInboundId(msg);
  const dedupeKey = buildInboundDedupeKey(msg);
  const receivedAt = Date.now();

  const inserted = await store.set(`inbound:dedupe:${dedupeKey}`, inboundId, {
    nx: true,
    exSeconds: dedupeTtlSeconds(),
  });

  if (!inserted) {
    return {
      accepted: false,
      inboundId,
      dedupeKey,
      sessionId: msg.sessionId,
      reason: "duplicate",
    };
  }

  const queued: QueuedInboundMessage = {
    ...msg,
    inboundId,
    receivedAt,
    dedupeKey,
  };

  await store.hset(DATA_HASH, inboundId, queued as any);
  await store.zadd(pendingZKey(msg.sessionId), receivedAt, inboundId);
  await store.zadd(SESSION_INDEX, receivedAt, msg.sessionId);

  return {
    accepted: true,
    inboundId,
    dedupeKey,
    sessionId: msg.sessionId,
    reason: "queued",
  };
}

export async function acquireSessionProcessor(sessionId: string): Promise<{ acquired: boolean; token: string }> {
  const store = getStore();
  const token = `${Date.now()}:${shortHash(`${sessionId}:${Math.random()}`, 18)}`;
  const ttlSeconds = sessionProcessorTtlSeconds();
  const acquired = await store.set(`session:processor:${sessionId}`, token, {
    nx: true,
    exSeconds: ttlSeconds,
  });
  return { acquired, token };
}

export async function releaseSessionProcessor(sessionId: string, token: string): Promise<void> {
  const store = getStore();
  const key = `session:processor:${sessionId}`;
  const current = await store.get<string>(key);
  if (current === token) await store.del(key);
}

export async function renewSessionProcessor(sessionId: string, token: string): Promise<boolean> {
  const store = getStore();
  const key = `session:processor:${sessionId}`;
  const current = await store.get<string>(key);
  if (current !== token) return false;
  await store.set(key, token, { exSeconds: sessionProcessorTtlSeconds() });
  return true;
}

async function loadPendingMessages(sessionId: string, limit: number): Promise<QueuedInboundMessage[]> {
  const store = getStore();
  const max = Math.max(1, Math.min(50, Math.floor(limit)));
  const ids = await store.zrangebyscore(pendingZKey(sessionId), 0, Date.now(), { limit: max });
  const out: QueuedInboundMessage[] = [];

  for (const id of ids) {
    const msg = await store.hget<QueuedInboundMessage>(DATA_HASH, id);
    if (msg) out.push(msg);
  }

  out.sort((a, b) => (a.receivedAt || a.ts || 0) - (b.receivedAt || b.ts || 0));
  return out;
}

function pendingSnapshotFromMessages(messages: QueuedInboundMessage[], nowMs = Date.now()): PendingSessionSnapshot {
  if (!messages.length) return { pending: 0, ready: true, waitMs: 0 };

  const times = messages.map((m) => Number(m.receivedAt || m.ts || nowMs)).filter((n) => Number.isFinite(n));
  const oldestReceivedAt = Math.min(...times);
  const newestReceivedAt = Math.max(...times);
  const waitMs = Math.max(0, newestReceivedAt + coalesceQuietMs() - nowMs);

  return {
    pending: messages.length,
    ready: waitMs <= 0,
    waitMs,
    oldestReceivedAt,
    newestReceivedAt,
  };
}

export async function getPendingSessionSnapshot(sessionId: string, limit?: number): Promise<PendingSessionSnapshot> {
  const max = Math.max(1, Math.min(50, Math.floor(Number(limit ?? process.env.SESSION_MAX_MESSAGES_PER_BATCH ?? 12))));
  const messages = await loadPendingMessages(sessionId, max);
  return pendingSnapshotFromMessages(messages);
}

export async function claimPendingInboundMessages(sessionId: string, limit?: number): Promise<QueuedInboundMessage[]> {
  const store = getStore();
  const now = Date.now();
  const max = Math.max(1, Math.min(50, Math.floor(Number(limit ?? process.env.SESSION_MAX_MESSAGES_PER_BATCH ?? 12))));
  const ids = await store.zrangebyscore(pendingZKey(sessionId), 0, now, { limit: max });
  const loaded: QueuedInboundMessage[] = [];

  for (const id of ids) {
    const msg = await store.hget<QueuedInboundMessage>(DATA_HASH, id);
    if (msg) loaded.push(msg);
    else await store.zrem(pendingZKey(sessionId), id);
  }

  loaded.sort((a, b) => (a.receivedAt || a.ts || 0) - (b.receivedAt || b.ts || 0));

  // Quiet-window guard: do not claim a batch while a split long message may still be arriving.
  // This makes coalescing depend on the actual newest provider message, not on when the workflow woke up.
  const snapshot = pendingSnapshotFromMessages(loaded, now);
  if (!snapshot.ready) return [];

  const out: QueuedInboundMessage[] = [];
  for (const msg of loaded) {
    await store.zrem(pendingZKey(sessionId), msg.inboundId);
    const claimedAt = Date.now();
    await store.hset(PROCESSING_HASH, msg.inboundId, { ...msg, claimedAt } as any);
    await store.zadd(PROCESSING_INDEX, claimedAt, msg.inboundId);
    out.push(msg);
  }

  return out;
}

export async function completeInboundMessages(ids: string[]): Promise<void> {
  const store = getStore();
  for (const id of ids) {
    await store.hdel(PROCESSING_HASH, id);
    await store.hdel(DATA_HASH, id);
    await store.zrem(PROCESSING_INDEX, id);
  }
}

export async function requeueInboundMessages(messages: QueuedInboundMessage[]): Promise<void> {
  const store = getStore();
  for (const msg of messages) {
    await store.hdel(PROCESSING_HASH, msg.inboundId);
    await store.zrem(PROCESSING_INDEX, msg.inboundId);
    await store.hset(DATA_HASH, msg.inboundId, msg as any);
    await store.zadd(pendingZKey(msg.sessionId), Date.now(), msg.inboundId);
    await store.zadd(SESSION_INDEX, Date.now(), msg.sessionId);
  }
}

export async function recoverStaleInboundMessages(): Promise<{ recovered: number }> {
  const store = getStore();
  const cutoff = Date.now() - processingLeaseMs();
  const ids = await store.zrangebyscore(PROCESSING_INDEX, 0, cutoff, { limit: 50 });
  let recovered = 0;

  for (const id of ids) {
    const msg = await store.hget<any>(PROCESSING_HASH, id);
    await store.zrem(PROCESSING_INDEX, id);
    await store.hdel(PROCESSING_HASH, id);

    if (!msg?.sessionId) continue;

    const queued: QueuedInboundMessage = {
      ...(msg as QueuedInboundMessage),
      receivedAt: Date.now(),
    };
    await store.hset(DATA_HASH, id, queued as any);
    await store.zadd(pendingZKey(queued.sessionId), Date.now(), id);
    await store.zadd(SESSION_INDEX, Date.now(), queued.sessionId);
    recovered += 1;
  }

  return { recovered };
}

export async function listPendingSessionIds(limit = 20): Promise<string[]> {
  const store = getStore();
  const ids = await store.zrangebyscore(SESSION_INDEX, 0, Date.now(), {
    limit: Math.max(1, Math.min(100, Math.floor(limit))),
  });

  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function markSessionQueueIdle(sessionId: string): Promise<void> {
  const store = getStore();
  await store.zrem(SESSION_INDEX, sessionId);
}

export function fallbackCoalesceMessages(messages: QueuedInboundMessage[]): LogicalUserInput[] {
  if (!messages.length) return [];

  if (messages.length === 1) {
    const m = messages[0]!;
    return [{
      id: shortHash({ sourceInboundIds: [m.inboundId], text: m.text }, 18),
      text: m.text,
      sourceInboundIds: [m.inboundId],
      relation: "single",
      confidence: 0.7,
    }];
  }

  const allSameSender = messages.every((m) => m.senderId === messages[0]!.senderId && m.sessionId === messages[0]!.sessionId);
  const spanMs = Math.max(...messages.map((m) => m.receivedAt)) - Math.min(...messages.map((m) => m.receivedAt));
  const combined = messages.map((m) => String(m.text ?? "").trim()).filter(Boolean).join("\n");

  if (allSameSender && spanMs <= Number(process.env.SPLIT_MESSAGE_JOIN_WINDOW_MS ?? 4500)) {
    return [{
      id: shortHash({ sourceInboundIds: messages.map((m) => m.inboundId), text: combined }, 18),
      text: combined,
      sourceInboundIds: messages.map((m) => m.inboundId),
      relation: "joined_fragments",
      confidence: 0.5,
    }];
  }

  return messages.map((m) => ({
    id: shortHash({ sourceInboundIds: [m.inboundId], text: m.text }, 18),
    text: m.text,
    sourceInboundIds: [m.inboundId],
    relation: "fallback" as const,
    confidence: 0.35,
  }));
}

export function buildLogicalInputId(input: LogicalUserInput): string {
  return shortHash({ sourceInboundIds: input.sourceInboundIds, text: input.text }, 28);
}

export function buildTurnId(sessionId: string, input: LogicalUserInput): string {
  return shortHash({ sessionId, logicalInput: buildLogicalInputId(input) }, 32);
}

export function inboundBatchDebug(messages: QueuedInboundMessage[]): string {
  return stableStringify(messages.map((m) => ({
    inboundId: m.inboundId,
    receivedAt: m.receivedAt,
    text: String(m.text ?? "").slice(0, 240),
  })));
}
