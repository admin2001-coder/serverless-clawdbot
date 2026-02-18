import { getStore } from "@/app/lib/store";
import type { Channel } from "@/app/lib/identity";

export type SessionMeta = {
  channel: Channel;
  sessionId: string;
  senderId: string;
  senderUsername?: string;
  updatedAt: number;
};

export async function saveSessionMeta(meta: SessionMeta, opts?: { updateLast?: boolean }): Promise<void> {
  const store = getStore();
  await store.set(`sess:meta:${meta.sessionId}`, meta);

  if (opts?.updateLast) {
    // Track last session per channel + globally (used by /webhook delivery)
    await store.set(`last:${meta.channel}`, meta.sessionId);
    await store.set(`last:any`, { channel: meta.channel, sessionId: meta.sessionId, updatedAt: meta.updatedAt });
  }
}

export async function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const store = getStore();
  return await store.get<SessionMeta>(`sess:meta:${sessionId}`);
}

export async function getLastSession(channel: Channel | "any"): Promise<{ channel: Channel; sessionId: string } | null> {
  const store = getStore();
  if (channel === "any") {
    const v = await store.get<any>("last:any");
    if (v?.channel && v?.sessionId) return { channel: v.channel, sessionId: v.sessionId };
    return null;
  }
  const sessionId = await store.get<string>(`last:${channel}`);
  if (!sessionId) return null;
  return { channel, sessionId };
}
