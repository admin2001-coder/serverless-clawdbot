import crypto from "crypto";
import { getStore } from "@/app/lib/store";
import type { Channel } from "@/app/lib/identity";
import { safeKeyPart, shortHash } from "@/app/lib/hash";

export type Task =
  | {
      id: string;
      type: "send";
      dueAt: number; // epoch ms
      channel: Channel;
      sessionId: string;
      text: string;
      createdAt: number;
      createdBy: "agent" | "system" | "user";
      attempts?: number;
      maxAttempts?: number;
      idempotencyKey?: string;
      lastError?: string;
    }
  | {
      id: string;
      type: "noop";
      dueAt: number;
      createdAt: number;
      createdBy: "agent" | "system" | "user";
      attempts?: number;
      maxAttempts?: number;
      idempotencyKey?: string;
      lastError?: string;
    };

const ZKEY = "tasks:due"; // sorted set of task IDs by dueAt
const HKEY = "tasks:data"; // hash of taskId -> Task JSON

function taskLeaseKey(id: string) {
  return `tasks:lease:${safeKeyPart(id, 160)}`;
}

function taskDedupeKey(idempotencyKey: string) {
  return `tasks:dedupe:${safeKeyPart(idempotencyKey, 220)}`;
}

export function buildSendTaskIdempotencyKey(args: {
  channel: Channel;
  sessionId: string;
  dueAt: number;
  text: string;
  createdBy: "agent" | "system" | "user";
}) {
  const roundedDue = Math.floor(args.dueAt / 60_000) * 60_000;
  return shortHash({ ...args, dueAt: roundedDue }, 32);
}

export async function createSendTask(
  args: Omit<Extract<Task, { type: "send" }>, "id" | "createdAt"> & { idempotencyKey?: string }
) {
  const store = getStore();
  const idempotencyKey = args.idempotencyKey ?? buildSendTaskIdempotencyKey(args);
  const dedupeInserted = await store.set(taskDedupeKey(idempotencyKey), "pending", {
    nx: true,
    exSeconds: Math.max(3600, Number(process.env.TASK_DEDUPE_TTL_SECONDS ?? 60 * 60 * 24 * 30)),
  });

  if (!dedupeInserted) {
    const existing = await store.get<string>(taskDedupeKey(idempotencyKey));
    return existing && existing !== "pending" ? existing : idempotencyKey;
  }

  const id = crypto.randomUUID();
  const task: Task = {
    ...args,
    id,
    idempotencyKey,
    attempts: 0,
    maxAttempts: args.maxAttempts ?? Number(process.env.TASK_MAX_ATTEMPTS ?? 5),
    createdAt: Date.now(),
  } as any;

  await store.hset(HKEY, id, task);
  await store.zadd(ZKEY, task.dueAt, id);
  await store.set(taskDedupeKey(idempotencyKey), id, {
    exSeconds: Math.max(3600, Number(process.env.TASK_DEDUPE_TTL_SECONDS ?? 60 * 60 * 24 * 30)),
  });
  return id;
}

export async function fetchDueTaskIds(nowMs: number, limit = 25): Promise<string[]> {
  const store = getStore();
  return await store.zrangebyscore(ZKEY, 0, nowMs, { limit });
}

export async function getTask(id: string): Promise<Task | null> {
  const store = getStore();
  return await store.hget<Task>(HKEY, id);
}

export async function saveTask(task: Task): Promise<void> {
  const store = getStore();
  await store.hset(HKEY, task.id, task);
  await store.zadd(ZKEY, task.dueAt, task.id);
}

export async function deleteTask(id: string): Promise<void> {
  const store = getStore();
  const task = await getTask(id);
  await store.zrem(ZKEY, id);
  await store.hdel(HKEY, id);
  await store.del(taskLeaseKey(id));
  if (task?.idempotencyKey) {
    await store.set(taskDedupeKey(task.idempotencyKey), id, {
      exSeconds: Math.max(3600, Number(process.env.TASK_DEDUPE_TTL_SECONDS ?? 60 * 60 * 24 * 30)),
    });
  }
}

export async function claimTask(id: string, leaseSeconds = 120): Promise<{ claimed: boolean; token: string }> {
  const store = getStore();
  const token = `${Date.now()}:${shortHash(`${id}:${Math.random()}`, 16)}`;
  const claimed = await store.set(taskLeaseKey(id), token, {
    nx: true,
    exSeconds: Math.max(5, Math.floor(leaseSeconds)),
  });
  return { claimed, token };
}

export async function releaseTaskClaim(id: string, token: string): Promise<void> {
  const store = getStore();
  const key = taskLeaseKey(id);
  const current = await store.get<string>(key);
  if (current === token) await store.del(key);
}

export async function rescheduleTaskAfterError(task: Task, error: unknown): Promise<Task | null> {
  const attempts = Math.max(0, Number(task.attempts ?? 0)) + 1;
  const maxAttempts = Math.max(1, Number(task.maxAttempts ?? process.env.TASK_MAX_ATTEMPTS ?? 5));
  const message = error instanceof Error ? error.message : String(error ?? "Unknown task error");

  if (attempts >= maxAttempts) {
    await deleteTask(task.id);
    return null;
  }

  const backoffMs = Math.min(60 * 60 * 1000, Math.pow(2, attempts) * 30_000);
  const next: Task = {
    ...(task as any),
    attempts,
    maxAttempts,
    dueAt: Date.now() + backoffMs,
    lastError: message.slice(0, 1000),
  };
  await saveTask(next);
  return next;
}
