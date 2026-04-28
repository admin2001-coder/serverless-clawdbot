import { start } from "workflow/api";
import { autopilotWorkflow } from "@/app/workflows/autopilot";
import {
  acquireAutopilotStartLock,
  getAutopilotHeartbeat,
  getPrimary,
  isAutopilotEnabled,
  setPrimary,
  type PrimaryTarget,
} from "@/app/lib/autopilotState";
import { getLastSession } from "@/app/lib/sessionMeta";

const AUTOPILOT_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

export async function ensureAutopilotPrimary(): Promise<PrimaryTarget | null> {
  const existing = await getPrimary();
  if (existing) return existing;

  const last = await getLastSession("any");
  if (!last) return null;

  const primary: PrimaryTarget = {
    channel: last.channel,
    sessionId: last.sessionId,
  };
  await setPrimary(primary);
  return primary;
}

export async function startAutopilotIfNeeded(reason: "cron" | "ui") {
  const enabled = await isAutopilotEnabled();
  if (!enabled) {
    return {
      enabled,
      started: false,
      reason: "disabled",
    };
  }

  const primary = await ensureAutopilotPrimary();
  if (!primary) {
    return {
      enabled,
      started: false,
      reason: "no_primary",
    };
  }

  const heartbeat = await getAutopilotHeartbeat();
  const heartbeatAgeMs = heartbeat ? Date.now() - heartbeat.ts : null;

  if (
    heartbeat &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs >= 0 &&
    heartbeatAgeMs < AUTOPILOT_HEARTBEAT_STALE_MS &&
    heartbeat.state !== "disabled"
  ) {
    return {
      enabled,
      started: false,
      reason: "heartbeat_fresh",
      heartbeatAgeMs,
      heartbeatState: heartbeat.state,
      primary,
    };
  }

  const acquiredLock = await acquireAutopilotStartLock(`cron_${Date.now()}`);
  if (!acquiredLock) {
    return {
      enabled,
      started: false,
      reason: "start_lock_held",
      heartbeatAgeMs,
      heartbeatState: heartbeat?.state,
      primary,
    };
  }

  const run = await start(autopilotWorkflow, []);

  return {
    enabled,
    started: true,
    reason,
    runId: run.runId,
    heartbeatAgeMs,
    heartbeatState: heartbeat?.state,
    primary,
  };
}
