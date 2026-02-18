import { sleep } from "workflow";
import { agentTurn } from "@/app/steps/agentTurn";
import { sendOutboundRuntime } from "@/app/lib/outbound";
import { getPrimary, isAutopilotEnabled, getIntervalSeconds } from "@/app/lib/autopilotState";

export async function autopilotWorkflow() {
  "use workflow";

  while (true) {
    const enabled = await isAutopilotEnabled();
    if (!enabled) {
      await sleep("5s");
      continue;
    }

    const primary = await getPrimary();
    if (!primary) {
      // no destination yet; wait
      await sleep("10s");
      continue;
    }

    // Ask the agent to proactively check what matters.
    const result = await agentTurn({
      sessionId: primary.sessionId,
      userId: primary.sessionId, // IMPORTANT: identity match for Composio (telegram:<id>, etc.)
      channel: primary.channel,
      history: [
        {
          role: "user",
          content:
            "You are in AUTOPILOT mode. Proactively review pending tasks, scheduled reminders, and monitors. " +
            "Send me only important updates or questions. If nothing important, send nothing. " +
            "If you need follow-ups, ask 1 short question. If you schedule reminders, use schedule_message.",
        },
      ],
    });

    const text = (result.text ?? "").trim();

    // If model decides “nothing”, it should return empty — honor that.
    if (text.length > 0 && text.toLowerCase() !== "no updates") {
      await sendOutboundRuntime({
        channel: primary.channel,
        sessionId: primary.sessionId,
        text,
      });
    }

    const interval = await getIntervalSeconds();
    await sleep(`${interval}s`);
  }
}
