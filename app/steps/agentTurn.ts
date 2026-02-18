// app/workflows/agentTurn.ts
import { generateText, stepCountIs, tool, type ToolSet, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { z } from "zod";

import { env, csvEnv } from "@/app/lib/env";
import type { Channel } from "@/app/lib/identity";
import { createSendTask } from "@/app/lib/tasks";
import { sshExec } from "@/app/steps/sshExec";
const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";

// ============================================================
// Composio
// ============================================================
const composio = new Composio({ provider: new VercelProvider() });

// ============================================================
// BobbyApproved helpers
// ============================================================
function bobbyBaseUrl(): string {
  return env("BOBBY_BASE_URL") ?? "https://prod.bobbyapprovedapp.com";
}

function bobbyJwt(): string | null {
  return env("BOBBY_JWT") ?? null;
}

function assertBobbyJwt() {
  const jwt = bobbyJwt();
  if (!jwt) throw new Error("Missing BOBBY_JWT env var");
  return jwt;
}

const BOBBY_ALLOWED_IMAGE_HOSTS = new Set(["cdn-bobbyapproved.flavcity.com"]);

// Normalize Bobby API’s huge payload into a compact response (faster + more accurate for the LLM)
type BobbyNormalizedProduct = {
  id: string;
  name: string;
  brandName?: string;
  approvalStatus?: string;
  images?: { small?: string; medium?: string; large?: string };
};

type BobbyNormalizedSearch = {
  ok: true;
  term: string;
  total?: number;
  top: BobbyNormalizedProduct[];
  aggregations?: {
    Brand?: Array<{ key: string; value: number }>;
    Category?: Array<{ key: string; value: number }>;
    Ingredient?: Array<{ key: string; value: number }>;
  };
};

function normalizeBobbySearch(term: string, raw: any): BobbyNormalizedSearch {
  const results: any[] = Array.isArray(raw?.results) ? raw.results : [];
  const top = results.slice(0, 20).map((r) => ({
    id: String(r?.id ?? ""),
    name: String(r?.name ?? ""),
    brandName: r?.brandName ? String(r.brandName) : undefined,
    approvalStatus: r?.approvalStatus ? String(r.approvalStatus) : undefined,
    images: {
      small: r?.smallImage ? String(r.smallImage) : undefined,
      medium: r?.mediumImage ? String(r.mediumImage) : undefined,
      large: r?.largeImage ? String(r.largeImage) : undefined,
    },
  }));

  const aggs = raw?.aggregations ?? raw?.data?.aggregations ?? undefined;
  const pickAgg = (k: string) => {
    const a = aggs?.[k];
    if (!Array.isArray(a)) return undefined;
    return a
      .slice(0, 25)
      .map((x: any) => ({ key: String(x?.key ?? ""), value: Number(x?.value ?? 0) }))
      .filter((x: any) => x.key);
  };

  return {
    ok: true,
    term,
    total: typeof raw?.total === "number" ? raw.total : undefined,
    top,
    aggregations: {
      Brand: pickAgg("Brand"),
      Category: pickAgg("Category"),
      Ingredient: pickAgg("Ingredient"),
    },
  };
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ============================================================
// Tool filtering
// ============================================================
function filterTools(tools: ToolSet, allow: string[]): ToolSet {
  if (!allow.length) return tools;
  if (allow.includes("*")) return tools;
  const out: any = {};
  for (const [name, def] of Object.entries(tools as any)) {
    if (allow.includes(name)) out[name] = def;
  }
  return out as ToolSet;
}

// ============================================================
// History helpers
// ============================================================
function historyHasImages(history: ModelMessage[]): boolean {
  for (const m of history) {
    const c: any = (m as any)?.content;
    if (!Array.isArray(c)) continue;
    if (c.some((p: any) => p?.type === "image")) return true;
  }
  return false;
}

function normalizeHistory(history: ModelMessage[]): ModelMessage[] {
  return history.map((m) => {
    const anyM: any = m as any;
    const c: any = anyM?.content;

    if (Array.isArray(c)) return m;

    if (typeof c === "string") {
      return { ...m, content: [{ type: "text" as const, text: c }] } as any;
    }

    return m;
  });
}

function extractRecentUserText(history: ModelMessage[], maxChars = 1200): string {
  // Pull the last few user text parts to help routing without requiring literals
  const chunks: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m: any = history[i];
    if (m?.role !== "user") continue;

    const c: any = m?.content;
    if (typeof c === "string" && c.trim()) chunks.push(c.trim());
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === "text" && typeof p?.text === "string" && p.text.trim()) {
          chunks.push(p.text.trim());
        }
      }
    }

    if (chunks.join("\n").length >= maxChars) break;
  }
  const out = chunks.reverse().join("\n").slice(0, maxChars);
  return out || "";
}

// ============================================================
// Optional helpers for ingestion layer
// ============================================================
export function userMessageWithImageUrl(opts: { text?: string; imageUrl: string }): ModelMessage {
  return {
    role: "user",
    content: [
      ...(opts.text ? [{ type: "text" as const, text: opts.text }] : []),
      { type: "image" as const, image: new URL(opts.imageUrl) },
    ],
  };
}
export function assistantMessageWithImageUrl(opts: { text?: string; imageUrl: string }): ModelMessage {
  return {
    role: "assistant",
    content: [
      ...(opts.text ? [{ type: "text" as const, text: opts.text }] : []),
      { type: "image" as const, image: new URL(opts.imageUrl) },
    ],
  } as any;
}

export function userMessageWithImageBase64(opts: { text?: string; base64: string }): ModelMessage {
  return {
    role: "user",
    content: [
      ...(opts.text ? [{ type: "text" as const, text: opts.text }] : []),
      { type: "image" as const, image: opts.base64 },
    ],
  };
}
function shouldAskClarifyingQuestion(opts: {
  autonomy: string;
  toolName?: string;
  missingFields?: string[];
  risky?: boolean;
}): boolean {
  // In assistive mode: only ask if we literally cannot execute.
  if (opts.autonomy === "assistive") {
    return Boolean(opts.missingFields && opts.missingFields.length > 0);
  }

  // In full mode: ask even less.
  // Only ask when there is a hard block (missing required inputs).
  if (opts.autonomy === "full") {
    return Boolean(opts.missingFields && opts.missingFields.length > 0);
  }

  return true;
}

// ============================================================
// “Smart router” (reduces literal tool calls + redundant questions)
// ============================================================
const TurnPlanSchema = z.object({
  intent: z.enum([
    "bobby.search",
    "bobby.typeahead",
    "bobby.allergens",
    "ssh.exec",
    "schedule",
    "general.chat",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
args: z.record(z.string(), z.unknown()).optional(),
  needs_clarification: z.boolean().optional(),
  clarification_question: z.string().optional(),
});

type TurnPlan = z.infer<typeof TurnPlanSchema>;

async function routeTurn(opts: {
  userText: string;
  hasImages: boolean;
  autonomy: string;
  modelName?: string;
}): Promise<TurnPlan> {
  const routerModel = openai(env("ROUTER_MODEL_NAME") ?? "gpt-4o-mini");

const system = [
  "You are Clawdbot. You follow the user's instructions immediately and minimize questions.",
  "",
  "Behavior rules (VERY IMPORTANT):",
  "- Treat every user message as a command unless it is clearly casual conversation.",
  "- Do not ask follow-up questions unless you cannot proceed without missing required info.",
  "- If a tool call is obvious, call it immediately. Do not ask for confirmation for read-only actions.",
  "- Ask at most ONE clarifying question when required.",
  "- Never repeat the user's request back to them unless asked.",
  "",
  "BobbyApproved:",
  "- If user asks for a product image, search BobbyApproved using best-effort term extraction and send the FIRST result image.",
  "- If user asks for approval, search and answer from the FIRST relevant result.",
  "",
  "SSH:",
  "- Only block destructive commands (rm/sudo/etc). For non-destructive commands, run immediately.",
  "",
  `Current mode: ${autonomy}`,
].join("\n");

  const user = [
    `hasImages=${opts.hasImages}`,
    "User text:",
    opts.userText || "(empty)",
  ].join("\n");

  const r = await generateText({
    model: routerModel,
    system,
    prompt: user,
    stopWhen: stepCountIs(3),
  });

  const parsed = safeJsonParse(r.text);
  const sp = TurnPlanSchema.safeParse(parsed);
  if (sp.success) return sp.data;

  // Fallback: if parsing fails, be conservative
  return { intent: "general.chat", confidence: 0.3 };
}

// ============================================================
// BobbyApproved tool (NATURAL interface, no op literals required)
// ============================================================
const bobby = tool({
  description:
    "BobbyApproved smart tool: product search, typeahead, allergens, and safe CDN image fetch. Accepts natural language so the user doesn't need literal params.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Natural language request, e.g. 'search eggs', 'typeahead egg', 'show allergens'."),
    // Optional explicit overrides (the router can fill these)
    term: z.string().optional().describe("If provided, use as the search term."),
    mode: z.enum(["auto", "search", "typeahead", "allergens"]).default("auto"),
    size: z.number().int().min(1).max(500).default(100),
    enableAlmostApproved: z.boolean().default(true),
    approvalStatuses: z.array(z.string()).default([]),
    fetchImageUrl: z.string().optional().describe("If provided, safely fetch the image from the Bobby CDN."),
  }),
  execute: async (input) => {
    const jwt = assertBobbyJwt();
    const base = bobbyBaseUrl();

    const doJson = async (path: string, init: RequestInit) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
          accept: "application/json",
        },
      });

      const text = await res.text();
      if (!res.ok) return { ok: false as const, status: res.status, body: text };
      const data = safeJsonParse(text) ?? text;
      return { ok: true as const, status: res.status, data };
    };

    // Optional safe CDN image fetch (public per your logs)
    if (input.fetchImageUrl) {
      const u = new URL(input.fetchImageUrl);
      if (!BOBBY_ALLOWED_IMAGE_HOSTS.has(u.host)) {
        return { ok: false as const, status: 400, body: "Image host not allowed" };
      }
      const res = await fetch(u.toString(), { method: "GET" });
      if (!res.ok) return { ok: false as const, status: res.status, body: await res.text() };
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        ok: true as const,
        status: res.status,
        contentType: res.headers.get("content-type"),
        bytes: buf.length,
      };
    }

    const q = (input.query || "").toLowerCase();
    const inferredTerm = (input.term ?? "").trim();

    const wantAllergens =
      input.mode === "allergens" ||
      q.includes("allergen") ||
      q.includes("allergens") ||
      q.includes("ingredient allergies");

    const wantTypeahead =
      input.mode === "typeahead" ||
      q.startsWith("typeahead") ||
      q.includes("autocomplete") ||
      q.includes("suggest");

    const mode =
      input.mode === "search" ? "search" : wantAllergens ? "allergens" : wantTypeahead ? "typeahead" : "search";

    const term =
      inferredTerm ||
      input.query
        .replace(/^typeahead\s+/i, "")
        .replace(/^search\s+/i, "")
        .replace(/^find\s+/i, "")
        .replace(/^look up\s+/i, "")
        .replace(/^bobby\s+/i, "")
        .trim();

    if (mode === "allergens") {
      const res = await fetch(`${base}/catalog/navigation/allergens?size=${input.size ?? 50}`, {
        method: "GET",
        headers: { authorization: `Bearer ${jwt}`, accept: "application/json" },
      });
      const text = await res.text();
      if (!res.ok) return { ok: false as const, status: res.status, body: text };
      const data = safeJsonParse(text) ?? text;

      // Compress allergens response lightly
      const allergens = Array.isArray((data as any)?.allergens) ? (data as any).allergens : [];
      const compact = allergens.slice(0, 50).map((a: any) => ({
        id: String(a?.id ?? ""),
        displayName: String(a?.displayName ?? ""),
      }));
      return { ok: true as const, status: res.status, data: { status: "success", allergens: compact } };
    }

    if (!term) {
      return { ok: false as const, status: 400, body: "Missing term" };
    }

    if (mode === "typeahead") {
      const r = await doJson("/catalog/search/typeahead", {
        method: "POST",
        body: JSON.stringify({
          term,
          approvalStatuses: input.approvalStatuses ?? [],
        }),
      });

      // Compress typeahead
      if (r.ok) {
        const data: any = r.data;
        return {
          ok: true as const,
          status: r.status,
          data: {
            status: data?.status ?? "success",
            brands: Array.isArray(data?.brands) ? data.brands.slice(0, 25) : [],
            categories: Array.isArray(data?.categories) ? data.categories.slice(0, 25) : [],
            ingredients: Array.isArray(data?.ingredients) ? data.ingredients.slice(0, 25) : [],
            popularSearches: Array.isArray(data?.popularSearches) ? data.popularSearches.slice(0, 10) : [],
          },
        };
      }

      return r;
    }

    // default: search
    const r = await doJson("/catalog/search", {
      method: "POST",
      body: JSON.stringify({
        type: "productsWithAggregations",
        term,
        approvalStatuses: input.approvalStatuses ?? [],
        size: input.size ?? 100,
        enableAlmostApproved: input.enableAlmostApproved ?? true,
      }),
    });

    if (r.ok) {
      return {
        ok: true as const,
        status: r.status,
        data: normalizeBobbySearch(term, r.data),
      };
    }
    return r;
  },
});

// ============================================================
// SSH confirmation policy (kills redundant “are you sure” except when risky)
// ============================================================
function commandLooksDestructive(cmd: string): boolean {
  const c = cmd.trim().toLowerCase();
  const dangerous = [
    "rm ",
    "rm\t",
    "sudo ",
    "chmod ",
    "chown ",
    "mkfs",
    "dd ",
    "shutdown",
    "reboot",
    "kill ",
    "killall",
    ">:",
    "truncate",
  ];
  return dangerous.some((d) => c.startsWith(d) || c.includes(` ${d.trim()}`));
}

// ============================================================
// Main agent
// ============================================================
export async function agentTurn(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  history: ModelMessage[];
}) {
  "use step";

  const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";
  const hasImages = historyHasImages(args.history);

  // Model selection: vision-capable when images exist
  const defaultModel = hasImages ? "gpt-4.1" : "gpt-4o-mini";
  const modelName = env("MODEL_NAME") ?? defaultModel;

  // Build tools bound to session context
  const scheduleMessage = tool({
    description:
      "Schedule a message to be sent back to the same user/session in the future (for reminders, follow-ups, periodic check-ins).",
    inputSchema: z.object({
      delaySeconds: z.number().min(1).max(60 * 60 * 24 * 14),
      text: z.string().min(1).max(2000),
    }),
    execute: async ({ delaySeconds, text }) => {
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

  const sshTool = tool({
    description:
      "Run a SAFE allowlisted command over SSH. For destructive commands, requires confirm=true (or AUTONOMOUS_MODE=full and user explicitly asked).",
    inputSchema: z.object({
      command: z.string().min(1).max(500),
      confirm: z.boolean().optional().describe("Set true only if the user explicitly confirmed risky actions."),
    }),
    execute: async ({ command, confirm }) => {
      const risky = commandLooksDestructive(command);

      if (risky && autonomy !== "full" && !confirm) {
        return {
          ok: false,
          needs_confirmation: true,
          message:
            "That command looks destructive. Reply with 'confirm' (or re-send with explicit confirmation) if you really want to run it.",
          command,
        };
      }

      const output = await sshExec(command);
      return { ok: true, output };
    },
  });

  // Composio toolset
  let composioTools: ToolSet = {};
  if (env("COMPOSIO_API_KEY")) {
    const userScoped = await composio.create(args.userId);
    const tools = (await userScoped.tools()) as ToolSet;
    composioTools = filterTools(tools, csvEnv("COMPOSIO_ALLOWED_TOOLS"));
  }

  const tools: ToolSet = {
    ...composioTools,
    bobby, // <- smart Bobby tool (no op literals)
    schedule_message: scheduleMessage,
  };

  // Only include SSH tool when configured
  if (env("SSH_HOST") && env("SSH_USER") && env("SSH_PRIVATE_KEY_B64")) {
    (tools as any).ssh_exec = sshTool;
  }

  // ============================================================
  // Fast path: ROUTE first, then act without redundant confirmations
  // ============================================================
  const userText = extractRecentUserText(normalizeHistory(args.history));
  const plan = await routeTurn({
    userText,
    hasImages,
    autonomy,
    modelName,
  });

  // If router needs clarification, ask exactly one question
  if (plan.needs_clarification && plan.clarification_question) {
    return { text: plan.clarification_question, responseMessages: [] as any[] };
  }

  // High-confidence Bobby paths: call tool directly + craft response without another LLM pass
  if (plan.confidence >= 0.75 && plan.intent.startsWith("bobby.")) {
    const term = typeof plan.args?.term === "string" ? plan.args.term : undefined;
    const mode =
      plan.intent === "bobby.allergens"
        ? "allergens"
        : plan.intent === "bobby.typeahead"
          ? "typeahead"
          : "search";

    const size = typeof plan.args?.size === "number" ? plan.args.size : mode === "allergens" ? 50 : 100;

    const r: any = await (bobby as any).execute({
      query: userText || (term ? `search ${term}` : "search"),
      term,
      mode,
      size,
      enableAlmostApproved: true,
      approvalStatuses: [],
    });

    if (!r?.ok) {
      return {
        text: `BobbyApproved API error (${r?.status ?? "?"}): ${String(r?.body ?? "unknown error").slice(0, 500)}`,
        responseMessages: [] as any[],
      };
    }

    // Render compact, useful answer
    if (mode === "allergens") {
      const allergens: any[] = r?.data?.allergens ?? [];
      const list = allergens.slice(0, 25).map((a) => `- ${a.displayName} (${a.id})`).join("\n");
      return {
        text: `Allergens (top ${Math.min(25, allergens.length)}):\n${list || "(none found)"}`,
        responseMessages: [] as any[],
      };
    }

    if (mode === "typeahead") {
      const brands: any[] = r?.data?.brands ?? [];
      const cats: any[] = r?.data?.categories ?? [];
      const ing: any[] = r?.data?.ingredients ?? [];

      const lines = [
        `Typeahead for "${term ?? ""}":`,
        brands.length ? `Brands: ${brands.slice(0, 10).map((b) => b.name).join(", ")}` : "Brands: (none)",
        cats.length ? `Categories: ${cats.slice(0, 10).map((c) => c.name).join(", ")}` : "Categories: (none)",
        ing.length ? `Ingredients: ${ing.slice(0, 10).map((i) => i.displayName ?? i.name).join(", ")}` : "Ingredients: (none)",
      ].join("\n");

      return { text: lines, responseMessages: [] as any[] };
    }

    // search
    const data = r?.data as BobbyNormalizedSearch;
    const top = (data?.top ?? []).slice(0, 10);

    const items = top
      .map((p, idx) => {
        const brand = p.brandName ? `${p.brandName} — ` : "";
        const status = p.approvalStatus ? ` [${p.approvalStatus}]` : "";
        return `${idx + 1}. ${brand}${p.name}${status} (id: ${p.id})`;
      })
      .join("\n");

    const hints: string[] = [];
    const brandsAgg = data?.aggregations?.Brand?.slice(0, 5);
    if (brandsAgg?.length) hints.push(`Top brands: ${brandsAgg.map((x) => x.key).join(", ")}`);
    const catAgg = data?.aggregations?.Category?.slice(0, 5);
    if (catAgg?.length) hints.push(`Top categories: ${catAgg.map((x) => x.key).join(", ")}`);

    return {
      text: [`Bobby search for "${data?.term ?? term ?? userText}":`, items || "(no results)", hints.join("\n")].filter(Boolean).join("\n\n"),
      responseMessages: [] as any[],
    };
  }

  // ============================================================
  // General path: run the full agent with tools (still improved)
  // ============================================================
  const system = [
    "You are Clawdbot (aka clawd bot aka openclaw), an autonomous assistant running inside a messaging bot (Telegram / WhatsApp / SMS).",
    "You can use tools to take actions and schedule future follow-ups.",
    "You can run any command on the macbook via ssh",
    "",
    "Behavior upgrades (IMPORTANT):",
    "- Do NOT require the user to provide literal tool parameters. Infer them and use tools directly.",
    "- Avoid redundant confirmations. Only ask for confirmation if the action is risky/irreversible (e.g., destructive SSH).",
    "- When using Bobby tool, return concise results: top matches + approval status + product id. Ask at most ONE follow-up question if needed.",
    "- Prefer calling tools over long explanations when the user is asking for data.",
    "",
    "",
    `Current mode: full`,
    "",
    "Multimodal:",
    "- If the user provides images, analyze them carefully and reference visible details.",
    "- If the user asks if a product is approved and provides an image, infer keywords and try Bobby search.",
  ].join("\n");

  const result = await generateText({
    model: openai(modelName),
    system,
    messages: normalizeHistory(args.history),
    tools,
    stopWhen: stepCountIs(10),
  });

  return { text: result.text, responseMessages: result.response.messages };
}
