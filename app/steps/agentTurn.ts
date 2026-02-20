import { generateText, stepCountIs, tool, type ToolSet, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { z } from "zod";

import { env, csvEnv } from "@/app/lib/env";
import type { Channel } from "@/app/lib/identity";
import { createSendTask } from "@/app/lib/tasks";
import { sshExec } from "@/app/steps/sshExec";

const composio = new Composio({ provider: new VercelProvider() });

function filterTools(tools: ToolSet, allow: string[]): ToolSet {
  if (!allow.length) return tools;
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    if (allow.includes(name)) out[name] = def;
  }
  return out as ToolSet;
}

export async function agentTurn(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  history: ModelMessage[];
}) {
  "use step";

  const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";
  const modelName = env("MODEL_NAME") ?? "gpt-4o-mini";

  const scheduleMessageInput = z.object({
    delaySeconds: z.number().min(1).max(60 * 60 * 24 * 14).describe("Seconds from now to send the message."),
    text: z.string().min(1).max(2000).describe("Message text to send at that time."),
  });

  const scheduleMessage = tool({
    description:
      "Schedule a message to be sent back to the same user/session in the future (for reminders, follow-ups, periodic check-ins).",
    inputSchema: scheduleMessageInput,
    execute: async ({ delaySeconds, text }: z.infer<typeof scheduleMessageInput>) => {
      const dueAt = Date.now() + Math.floor(delaySeconds * 1000);
      const id = await createSendTask({
        type: "send",
        dueAt,
        channel: args.channel,
        sessionId: args.sessionId,
        text,
        createdBy: "agent",
      } as any);
      return { ok: true, taskId: id, dueAt };
    },
  });

  const sshToolInput = z.object({
    command: z.string().min(1).max(500),
  });

  const sshTool = tool({
    description:
      "Run a SAFE allowlisted command over SSH on a configured host. Commands are restricted by SSH_ALLOWED_PREFIXES.",
    inputSchema: sshToolInput,
    execute: async ({ command }: z.infer<typeof sshToolInput>) => {
      const output = await sshExec(command);
      return { ok: true, output };
    },
  });

  let composioTools: ToolSet = {};
  if (env("COMPOSIO_API_KEY")) {
    const userScoped = await composio.create(args.userId);
    const tools = (await userScoped.tools()) as ToolSet;
    composioTools = filterTools(tools, csvEnv("COMPOSIO_ALLOWED_TOOLS"));
  }

  const tools: ToolSet = {
    ...composioTools,
    schedule_message: scheduleMessage,
  };

  if (env("SSH_HOST") && env("SSH_USER") && env("SSH_PRIVATE_KEY_B64")) {
    (tools as any).ssh_exec = sshTool;
  }

  const system = [
    "You are an autonomous assistant running inside a messaging bot connected to composio api and its tools",
    "You can use tools to take actions and schedule future follow-ups.",
    "",
    "Safety & intent:",
    "- If AUTONOMOUS_MODE=assistive: avoid destructive actions (sending emails, deleting files, changing calendars, etc.) unless the user explicitly requested it.",
    "- If AUTONOMOUS_MODE=full: you may act more proactively, but still avoid irreversible or high-risk actions unless clearly justified.",
    "",
    `Current mode: full`,
    "",
    "Conversation style:",
    "- Be concise on SMS; slightly richer on Telegram/WhatsApp.",
    "- Confirm assumptions when it matters; otherwise make reasonable defaults.",
    "",
    "Scheduling:",
    "- Use schedule_message to remind the user later or to follow up.",
  ].join("\n");

  const result = await generateText({
    model: openai(modelName),
    system,
    messages: args.history,
    tools,
    stopWhen: stepCountIs(5),
  });

  return { text: result.text, responseMessages: result.response.messages };
}
