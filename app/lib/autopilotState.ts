import { getStore } from "@/app/lib/store";
import type { Channel } from "@/app/lib/identity";

export type PrimaryTarget = { channel: Channel; sessionId: string };
export type AutopilotHeartbeat = {
  ts: number;
  state: string;
};
const KEY_PRIMARY = "autopilot:primary";
const KEY_ENABLED = "autopilot:enabled";
const KEY_INTERVAL = "autopilot:interval_seconds";
const KEY_HEARTBEAT = "autopilot:heartbeat";
const KEY_START_LOCK = "autopilot:start_lock";
export async function getPrimary(): Promise<PrimaryTarget | null> {
  const store = getStore();
  return (await store.get<PrimaryTarget>(KEY_PRIMARY)) ?? null;
}

export async function setPrimary(target: PrimaryTarget): Promise<void> {
  const store = getStore();
  await store.set(KEY_PRIMARY, target);
}

export async function isAutopilotEnabled(): Promise<boolean> {
  const store = getStore();
  return (await store.get<string>(KEY_ENABLED)) === "1";
}

export async function setAutopilotEnabled(enabled: boolean): Promise<void> {
  const store = getStore();
  await store.set(KEY_ENABLED, enabled ? "1" : "0");
}

export async function getIntervalSeconds(): Promise<number> {
  const store = getStore();
  const v = await store.get<string>(KEY_INTERVAL);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 300; // default 5 minutes
}

export async function setIntervalSeconds(seconds: number): Promise<void> {
  const store = getStore();
  await store.set(KEY_INTERVAL, String(seconds));
}
export async function getAutopilotHeartbeat(): Promise<AutopilotHeartbeat | null> {
  const store = getStore();
  return (await store.get<AutopilotHeartbeat>(KEY_HEARTBEAT)) ?? null;
}

export async function setAutopilotHeartbeat(state: string): Promise<AutopilotHeartbeat> {
  const store = getStore();

  const heartbeat: AutopilotHeartbeat = {
    ts: Date.now(),
    state,
  };

  await store.set(KEY_HEARTBEAT, heartbeat, {
    exSeconds: 60 * 60 * 24 * 7,
  });

  // release start lock so cron can restart if needed
  await store.del(KEY_START_LOCK);

  return heartbeat;
}
export async function acquireAutopilotStartLock(
  reason = "unknown",
  ttlSeconds = 120,
): Promise<boolean> {
  const store = getStore();

  const existing = await store.get<{
    reason: string;
    ts: number;
  }>(KEY_START_LOCK);

  if (existing) return false;

  await store.set(
    KEY_START_LOCK,
    {
      reason,
      ts: Date.now(),
    },
    {
      exSeconds: ttlSeconds,
    },
  );

  return true;
}