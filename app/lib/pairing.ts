import crypto from "crypto";
import { getStore } from "@/app/lib/store";
import { allowIdentity } from "@/app/lib/identity";

function randomCode(): string {
  // 6-digit numeric
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export async function createPairing(identity: string): Promise<string> {
  const store = getStore();
  const code = randomCode();

  // Map code -> identity (TTL 15 minutes)
  await store.set(`pair:code:${code}`, identity, { exSeconds: 15 * 60 });
  // Map identity -> code (TTL 15 minutes)
  await store.set(`pair:pending:${identity}`, code, { exSeconds: 15 * 60 });

  return code;
}

export async function getPendingCode(identity: string): Promise<string | null> {
  const store = getStore();
  return await store.get<string>(`pair:pending:${identity}`);
}

export async function approvePairing(identity: string, code: string): Promise<boolean> {
  const store = getStore();
  const expectedIdentity = await store.get<string>(`pair:code:${code}`);
  if (!expectedIdentity) return false;
  if (expectedIdentity !== identity) return false;

  await allowIdentity(identity);

  // cleanup
  await store.del(`pair:code:${code}`);
  await store.del(`pair:pending:${identity}`);

  return true;
}
