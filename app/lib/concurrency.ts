import { getStore } from "@/app/lib/store";
import { safeKeyPart, shortHash, stableStringify } from "@/app/lib/hash";

export type Lease = {
  key: string;
  token: string;
  acquiredAt: number;
  ttlMs: number;
};

export type ToolCallRecord = {
  id: string;
  turnId: string;
  sessionId: string;
  userId: string;
  toolName: string;
  resourceKey: string;
  status: "running" | "done" | "error" | "blocked";
  startedAt: number;
  finishedAt?: number;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
};

function now() {
  return Date.now();
}

function lockKey(resourceKey: string): string {
  return `lock:${safeKeyPart(resourceKey, 180)}`;
}

function defaultToolLeaseTtlMs(): number {
  const seconds = Number(process.env.TOOL_RESOURCE_LOCK_SECONDS ?? 120);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 120;
  return Math.max(1_000, Math.min(60 * 60 * 1000, Math.floor(safeSeconds * 1000)));
}

export function previewJson(value: unknown, maxChars = 1000): string {
  const s = typeof value === "string" ? value : stableStringify(value);
  return s.length > maxChars ? `${s.slice(0, maxChars)}...[truncated ${s.length - maxChars}]` : s;
}

export async function acquireLease(resourceKey: string, ttlMs: number): Promise<Lease | null> {
  const store = getStore();
  const ttl = Math.max(1000, Math.floor(ttlMs));
  const token = `${now()}:${shortHash(`${resourceKey}:${Math.random()}:${now()}`, 18)}`;
  const ok = await store.set(
    lockKey(resourceKey),
    {
      token,
      resourceKey,
      acquiredAt: now(),
      expiresAt: now() + ttl,
    },
    { nx: true, exSeconds: Math.ceil(ttl / 1000) }
  );

  if (!ok) return null;
  return { key: resourceKey, token, acquiredAt: now(), ttlMs: ttl };
}

export async function releaseLease(lease: Lease | null): Promise<void> {
  if (!lease) return;
  const store = getStore();
  const key = lockKey(lease.key);
  const current = await store.get<any>(key);
  if (current?.token === lease.token) {
    await store.del(key);
  }
}

export async function withLease<T>(
  resourceKey: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts?: { onBlocked?: () => T | Promise<T> }
): Promise<T> {
  const lease = await acquireLease(resourceKey, ttlMs);
  if (!lease) {
    if (opts?.onBlocked) return await opts.onBlocked();
    throw new Error(`Resource is currently busy: ${resourceKey}`);
  }

  try {
    return await fn();
  } finally {
    await releaseLease(lease);
  }
}

export function inferResourceKey(args: {
  userId: string;
  sessionId: string;
  toolName: string;
  input?: unknown;
}): string {
  const input: any = args.input && typeof args.input === "object" ? args.input : {};
  const explicit =
    typeof input?.resourceKey === "string" && input.resourceKey.trim()
      ? input.resourceKey.trim()
      : typeof input?._resourceKey === "string" && input._resourceKey.trim()
        ? input._resourceKey.trim()
        : "";

  if (explicit) return `user:${safeKeyPart(args.userId)}:explicit:${safeKeyPart(explicit, 160)}`;

  const method = String(input?.method ?? "").toUpperCase();
  const path = String(input?.path ?? input?.url ?? input?.endpoint ?? "").trim();
  if (path) {
    const normalizedPath = path
      .replace(/[?].*$/g, "")
      .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id")
      .replace(/\/[0-9]{4,}(?=\/|$)/g, "/:id")
      .slice(0, 180);
    return `user:${safeKeyPart(args.userId)}:api:${safeKeyPart(method || "CALL")}:${safeKeyPart(normalizedPath, 180)}`;
  }

  const identifiers: Record<string, unknown> = {};
  const collect = (value: unknown, prefix = "") => {
    if (!value || typeof value !== "object") return;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const k = prefix ? `${prefix}.${key}` : key;
      if (raw == null) continue;

      if (
        /(^|[_-])(id|email|address|phone|number|url|uri|slug|name|thread|channel|file|path|account|calendar|drive|sheet|doc|repo|issue|ticket)($|[_-])/i.test(
          key
        ) &&
        (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean")
      ) {
        identifiers[k] = raw;
      } else if (typeof raw === "object" && Object.keys(identifiers).length < 20) {
        collect(raw, k);
      }
    }
  };
  collect(input);

  const identitySource = Object.keys(identifiers).length ? identifiers : input;
  return `user:${safeKeyPart(args.userId)}:tool:${safeKeyPart(args.toolName, 96)}:${shortHash(identitySource, 28)}`;
}

export async function recordToolCall(record: ToolCallRecord): Promise<void> {
  const store = getStore();
  await store.hset("coord:toolCalls", record.id, record as any);
  await store.zadd(`coord:toolCallsBySession:${record.sessionId}`, record.startedAt, record.id);
  await store.zadd(`coord:toolCallsByResource:${safeKeyPart(record.resourceKey, 160)}`, record.startedAt, record.id);
}

export async function updateToolCall(
  id: string,
  patch: Partial<Pick<ToolCallRecord, "status" | "finishedAt" | "outputPreview" | "error">>
): Promise<void> {
  const store = getStore();
  const prev = await store.hget<ToolCallRecord>("coord:toolCalls", id);
  if (!prev) return;
  await store.hset("coord:toolCalls", id, { ...prev, ...patch } as any);
}

export async function coordinatedToolExecute<T>(args: {
  turnId: string;
  sessionId: string;
  userId: string;
  toolName: string;
  input?: unknown;
  ttlMs?: number;
  execute: () => Promise<T>;
}): Promise<T | { ok: false; concurrency: { blocked: true; resourceKey: string; message: string } }> {
  const resourceKey = inferResourceKey({
    userId: args.userId,
    sessionId: args.sessionId,
    toolName: args.toolName,
    input: args.input,
  });
  const id = shortHash({ turnId: args.turnId, toolName: args.toolName, input: args.input, at: now() }, 32);
  const startedAt = now();

  const lease = await acquireLease(resourceKey, args.ttlMs ?? defaultToolLeaseTtlMs());
  if (!lease) {
    await recordToolCall({
      id,
      turnId: args.turnId,
      sessionId: args.sessionId,
      userId: args.userId,
      toolName: args.toolName,
      resourceKey,
      status: "blocked",
      startedAt,
      finishedAt: now(),
      inputPreview: previewJson(args.input),
      error: "resource_locked",
    });
    return {
      ok: false,
      concurrency: {
        blocked: true,
        resourceKey,
        message:
          "Another active turn is already using this resource. Do not perform a contradictory duplicate action; summarize the conflict or wait for the other turn to finish.",
      },
    };
  }

  await recordToolCall({
    id,
    turnId: args.turnId,
    sessionId: args.sessionId,
    userId: args.userId,
    toolName: args.toolName,
    resourceKey,
    status: "running",
    startedAt,
    inputPreview: previewJson(args.input),
  });

  try {
    const output = await args.execute();
    await updateToolCall(id, {
      status: "done",
      finishedAt: now(),
      outputPreview: previewJson(output),
    });
    return output;
  } catch (error: any) {
    await updateToolCall(id, {
      status: "error",
      finishedAt: now(),
      error: String(error?.message ?? error ?? "Unknown tool error"),
    });
    throw error;
  } finally {
    await releaseLease(lease);
  }
}

export function buildCoordinationContext(args: { sessionId: string; turnId: string }): string {
  return [
    `Turn id: ${args.turnId}`,
    `Session id: ${args.sessionId}`,
    "External tool calls are serialized by durable resource leases. If a tool reports a concurrency block, do not retry blindly and do not claim the action happened.",
    "When multiple active turns touch the same external resource, prefer one successful action plus a concise explanation over contradictory duplicate actions.",
  ].join("\n");
}
