// app/steps/sessionStateSteps.ts
import type { ModelMessage } from "ai";
import { getStore } from "@/app/lib/store";

const historyKey = (sessionId: string) => `sess:${sessionId}:history`;

function historyMaxMessages(): number {
  const n = Number(process.env.HISTORY_MAX_MESSAGES ?? "60");
  return Number.isFinite(n) && n > 0 ? Math.max(8, Math.min(300, Math.floor(n))) : 60;
}

export async function loadHistoryStep(sessionId: string): Promise<ModelMessage[]> {
  "use step";

  const store = getStore();
  const history = (await store.get<ModelMessage[]>(historyKey(sessionId))) ?? [];
  return Array.isArray(history) ? history : [];
}

export async function saveHistoryStep(sessionId: string, history: ModelMessage[]) {
  "use step";

  const store = getStore();
  const max = historyMaxMessages();
  const trimmed = Array.isArray(history) ? history.slice(-max) : [];
  await store.set(historyKey(sessionId), trimmed as any);
}
