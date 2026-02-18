import { getStore } from "@/app/lib/store";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const HISTORY_KEY_PREFIX = "sess:history:";

export async function loadHistory(sessionId: string): Promise<ChatMessage[]> {
  const store = getStore();
  const v = await store.get<ChatMessage[]>(`${HISTORY_KEY_PREFIX}${sessionId}`);
  return Array.isArray(v) ? v : [];
}

export async function saveHistory(sessionId: string, history: ChatMessage[]): Promise<void> {
  const store = getStore();
  // keep last 60 messages to control size
  const clipped = history.slice(-60);
  await store.set(`${HISTORY_KEY_PREFIX}${sessionId}`, clipped);
}
