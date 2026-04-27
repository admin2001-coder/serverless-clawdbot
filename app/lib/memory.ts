import { getStore } from "@/app/lib/store";
import { safeKeyPart, shortHash } from "@/app/lib/hash";

export type MemoryEvent = {
  id: string;
  userId: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at: number;
  source?: string;
  turnId?: string;
};

export type WorkItem = {
  id: string;
  userId: string;
  sessionId?: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled";
  notes?: string;
  resourceKey?: string;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
};

function userKey(userId: string, suffix: string): string {
  return `memory:${safeKeyPart(userId, 180)}:${suffix}`;
}

function sessionKey(sessionId: string, suffix: string): string {
  return `memory:session:${safeKeyPart(sessionId, 180)}:${suffix}`;
}

function eventDataKey(userId: string): string {
  return userKey(userId, "events:data");
}

function userEventIndexKey(userId: string): string {
  return userKey(userId, "events:index");
}

function sessionEventIndexKey(sessionId: string): string {
  return sessionKey(sessionId, "events:index");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimText(text: unknown, max = 6000): string {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...[truncated ${s.length - max}]`;
}

async function withMemoryLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const store = getStore();
  const key = userKey(userId, "lock");
  const token = `${Date.now()}:${shortHash(Math.random(), 12)}`;
  const rawAttempts = Number(process.env.MEMORY_LOCK_ATTEMPTS ?? 20);
  const attempts = Number.isFinite(rawAttempts) ? Math.max(1, Math.min(50, Math.floor(rawAttempts))) : 20;

  for (let i = 0; i < attempts; i++) {
    const acquired = await store.set(key, token, { nx: true, exSeconds: 60 });

    if (acquired) {
      try {
        return await fn();
      } finally {
        const current = await store.get<string>(key);
        if (current === token) await store.del(key);
      }
    }

    await delay(Math.min(500, 40 + i * 25));
  }

  throw new Error(`Durable memory lock unavailable for ${userId}`);
}

export async function appendMemoryEvent(args: Omit<MemoryEvent, "id" | "at"> & { at?: number }): Promise<MemoryEvent> {
  const at = args.at ?? Date.now();
  const event: MemoryEvent = {
    ...args,
    id: shortHash({ userId: args.userId, sessionId: args.sessionId, role: args.role, text: args.text, at }, 32),
    at,
    text: trimText(args.text),
  };

  const store = getStore();
  await store.hset(eventDataKey(args.userId), event.id, event as any);
  await store.zadd(userEventIndexKey(args.userId), event.at, event.id);
  await store.zadd(sessionEventIndexKey(args.sessionId), event.at, event.id);

  // Maintain the previous compact arrays as a compatibility/read fallback, but the source of truth is now
  // append-only hash + sorted indexes so concurrent turns do not overwrite one another's memory events.
  try {
    await withMemoryLock(args.userId, async () => {
      const userRecentKey = userKey(args.userId, "recentEvents");
      const sessionRecentKey = sessionKey(args.sessionId, "recentEvents");

      const userRecent = ((await store.get<MemoryEvent[]>(userRecentKey)) ?? []).filter((e) => e.id !== event.id);
      userRecent.push(event);
      await store.set(userRecentKey, userRecent.slice(-80) as any);

      const sessionRecent = ((await store.get<MemoryEvent[]>(sessionRecentKey)) ?? []).filter((e) => e.id !== event.id);
      sessionRecent.push(event);
      await store.set(sessionRecentKey, sessionRecent.slice(-60) as any);
    });
  } catch {
    // The indexed event write above already succeeded; compact cache maintenance is best effort.
  }

  return event;
}

async function readIndexedMemoryEvents(userId: string, indexKey: string, limit: number): Promise<MemoryEvent[]> {
  const store = getStore();
  const ids = await store.zrevrangebyscore(indexKey, Date.now() + 1, 0, { limit });
  const out: MemoryEvent[] = [];

  for (const id of ids) {
    const event = await store.hget<MemoryEvent>(eventDataKey(userId), id);
    if (event) out.push(event);
  }

  return out;
}

export async function getRecentMemoryEvents(userId: string, sessionId: string, limit = 18): Promise<MemoryEvent[]> {
  const store = getStore();
  const max = Math.max(1, Math.min(80, limit));
  const [sessionIndexed, userIndexed] = await Promise.all([
    readIndexedMemoryEvents(userId, sessionEventIndexKey(sessionId), max * 2),
    readIndexedMemoryEvents(userId, userEventIndexKey(userId), max * 2),
  ]);

  const legacySessionRecent = (await store.get<MemoryEvent[]>(sessionKey(sessionId, "recentEvents"))) ?? [];
  const legacyUserRecent = (await store.get<MemoryEvent[]>(userKey(userId, "recentEvents"))) ?? [];

  const seen = new Set<string>();
  const merged = [...sessionIndexed, ...userIndexed, ...legacySessionRecent, ...legacyUserRecent]
    .filter((e) => {
      if (!e?.id || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    .sort((a, b) => a.at - b.at);

  return merged.slice(-max);
}

export async function setMemoryFact(userId: string, key: string, value: string, opts?: { source?: string }): Promise<void> {
  await withMemoryLock(userId, async () => {
    const store = getStore();
    const factsKey = userKey(userId, "facts");
    const facts = (await store.get<Record<string, any>>(factsKey)) ?? {};
    facts[safeKeyPart(key, 80)] = {
      value: trimText(value, 2000),
      updatedAt: Date.now(),
      source: opts?.source ?? "agent",
    };
    await store.set(factsKey, facts as any);
  });
}

export async function getMemoryFacts(userId: string): Promise<Record<string, { value: string; updatedAt: number; source?: string }>> {
  const store = getStore();
  return (await store.get<any>(userKey(userId, "facts"))) ?? {};
}

export async function upsertWorkItem(args: {
  userId: string;
  sessionId?: string;
  id?: string;
  title: string;
  status?: WorkItem["status"];
  notes?: string;
  resourceKey?: string;
  turnId?: string;
}): Promise<WorkItem> {
  return await withMemoryLock(args.userId, async () => {
    const store = getStore();
    const key = userKey(args.userId, "workItems");
    const items = (await store.get<Record<string, WorkItem>>(key)) ?? {};
    const id = args.id ? safeKeyPart(args.id, 80) : shortHash({ title: args.title, sessionId: args.sessionId, userId: args.userId }, 18);
    const prev = items[id];
    const now = Date.now();
    const item: WorkItem = {
      id,
      userId: args.userId,
      sessionId: args.sessionId ?? prev?.sessionId,
      title: trimText(args.title, 300),
      status: args.status ?? prev?.status ?? "open",
      notes: args.notes != null ? trimText(args.notes, 2000) : prev?.notes,
      resourceKey: args.resourceKey ?? prev?.resourceKey,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      turnId: args.turnId ?? prev?.turnId,
    };
    items[id] = item;
    await store.set(key, items as any);
    return item;
  });
}

export async function listWorkItems(userId: string, opts?: { includeDone?: boolean; limit?: number }): Promise<WorkItem[]> {
  const store = getStore();
  const items = (await store.get<Record<string, WorkItem>>(userKey(userId, "workItems"))) ?? {};
  const includeDone = opts?.includeDone ?? false;
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 20));
  return Object.values(items)
    .filter((item) => includeDone || !["done", "cancelled"].includes(item.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export async function updateSessionSummary(sessionId: string, summary: string): Promise<void> {
  const store = getStore();
  await store.set(sessionKey(sessionId, "summary"), trimText(summary, 8000) as any);
}

export async function getSessionSummary(sessionId: string): Promise<string> {
  const store = getStore();
  return (await store.get<string>(sessionKey(sessionId, "summary"))) ?? "";
}

export async function buildDurableMemoryContext(userId: string, sessionId: string): Promise<string> {
  const [summary, facts, workItems, recent] = await Promise.all([
    getSessionSummary(sessionId),
    getMemoryFacts(userId),
    listWorkItems(userId, { includeDone: false, limit: 12 }),
    getRecentMemoryEvents(userId, sessionId, 12),
  ]);

  const lines: string[] = [];
  if (summary.trim()) {
    lines.push("Conversation summary:");
    lines.push(summary.trim());
  }

  const factEntries = Object.entries(facts).slice(-20);
  if (factEntries.length) {
    lines.push("Remembered user facts:");
    for (const [key, fact] of factEntries) {
      lines.push(`- ${key}: ${fact.value}`);
    }
  }

  if (workItems.length) {
    lines.push("Active durable work items:");
    for (const item of workItems) {
      lines.push(`- [${item.status}] ${item.id}: ${item.title}${item.notes ? ` — ${item.notes}` : ""}`);
    }
  }

  if (recent.length) {
    lines.push("Recent durable events:");
    for (const event of recent) {
      const when = new Date(event.at).toISOString();
      lines.push(`- ${when} ${event.role}: ${trimText(event.text, 400)}`);
    }
  }

  return lines.join("\n").trim();
}
