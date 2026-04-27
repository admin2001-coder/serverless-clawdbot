import { sleep } from "workflow";
import type { Channel } from "@/app/lib/identity";
import { agentTurn } from "@/app/steps/agentTurn";
import { sendOutbound } from "@/app/steps/sendOutbound";
import {
  getAutopilotRuntimeConfig,
  recordAutopilotHeartbeat,
} from "@/app/steps/autopilotSteps";

const HEARTBEAT_SLEEP_CHUNK_SECONDS = 60;

function normalizeAutopilotText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?\s]+$/g, "")
    .replace(/\s+/g, " ");
}

function shouldSendAutopilotText(text: string): boolean {
  const normalized = normalizeAutopilotText(text);
  if (!normalized) return false;

  return !new Set([
    "no updates",
    "nothing to report",
    "nothing important to report",
    "no important updates",
    "no action needed",
  ]).has(normalized);
}

function coerceSleepSeconds(seconds: number): number {
  return Math.max(1, Math.floor(Number.isFinite(seconds) ? seconds : 60));
}

async function sleepWithHeartbeat(totalSeconds: number, state: string): Promise<void> {
  let remaining = coerceSleepSeconds(totalSeconds);

  while (remaining > 0) {
    await recordAutopilotHeartbeat(state);
    const chunk = Math.min(remaining, HEARTBEAT_SLEEP_CHUNK_SECONDS);
    await sleep(`${chunk}s`);
    remaining -= chunk;
  }
}

function autopilotPrompt(channel: Channel): string {
  return [
    "You are in AUTOPILOT mode.",
    "Proactively review pending tasks, scheduled reminders, monitors, and connected-app state that may matter to the user.",
    "Use available tools when they are relevant and safe.",
    "Send the user important updates or short questions only when there is something worth interrupting them about.",
    "Avoid redundant messages. If there is nothing useful to report, answer exactly: No updates",
    "If you schedule reminders, use schedule_message.",
    `Current delivery channel: ${channel}.`,
  ].join("\n");
}

export async function autopilotWorkflow() {
  "use workflow";

  while (true) {
    const config = await getAutopilotRuntimeConfig();

    if (!config.enabled) {
      await recordAutopilotHeartbeat("disabled");
      return { ok: true, stopped: "disabled" };
    }

    if (!config.primary) {
      await sleepWithHeartbeat(60, "waiting_for_primary");
      continue;
    }

    await recordAutopilotHeartbeat("agent_turn");

    const result = await agentTurn({
      sessionId: config.primary.sessionId,
      userId: config.primary.sessionId,
      channel: config.primary.channel,
      showTyping: false,
      history: [
        {
          role: "user",
          content: autopilotPrompt(config.primary.channel),
        },
      ],
    });

    const text = (result.text ?? "").trim();

    if (shouldSendAutopilotText(text) && !(result as any).delivered) {
      await sendOutbound({
        channel: config.primary.channel,
        sessionId: config.primary.sessionId,
        text,
      });
    }

    await sleepWithHeartbeat(config.intervalSeconds, "sleeping");
  }
}
