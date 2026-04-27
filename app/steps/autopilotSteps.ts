import type { PrimaryTarget } from "@/app/lib/autopilotState";
import {
  getIntervalSeconds,
  getPrimary,
  isAutopilotEnabled,
  setAutopilotHeartbeat,
  setPrimary,
} from "@/app/lib/autopilotState";
import { getLastSession } from "@/app/lib/sessionMeta";

export type AutopilotRuntimeConfig = {
  enabled: boolean;
  primary: PrimaryTarget | null;
  intervalSeconds: number;
};

export async function getAutopilotRuntimeConfig(): Promise<AutopilotRuntimeConfig> {
  "use step";

  const enabled = await isAutopilotEnabled();
  const intervalSeconds = await getIntervalSeconds();
  let primary = await getPrimary();

  // If the operator enabled autopilot but never clicked “set primary”, use the
  // most recent allowed chat as the destination. Without this, the workflow can
  // run forever and never have anywhere to send proactive messages.
  if (!primary) {
    const last = await getLastSession("any");
    if (last) {
      primary = {
        channel: last.channel,
        sessionId: last.sessionId,
      };
      await setPrimary(primary);
    }
  }

  return {
    enabled,
    primary,
    intervalSeconds,
  };
}

export async function recordAutopilotHeartbeat(state: string) {
  "use step";
  return await setAutopilotHeartbeat(state);
}
