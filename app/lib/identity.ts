import { csvEnv } from "@/app/lib/env";
import { getStore } from "@/app/lib/store";

export type Channel = "telegram" | "whatsapp" | "sms";

export function makeIdentity(channel: Channel, senderId: string): string {
  return `${channel}:${senderId}`;
}

export async function isAdmin(identity: string): Promise<boolean> {
  const admins = csvEnv("ADMIN_IDENTITIES");
  return admins.includes(identity);
}

export async function isAllowed(identity: string): Promise<boolean> {
  if (await isAdmin(identity)) return true;

  const store = getStore();
  const v = await store.get<string>(`allow:${identity}`);
  return v === "1";
}

export async function allowIdentity(identity: string): Promise<void> {
  const store = getStore();
  await store.set(`allow:${identity}`, "1");
}
