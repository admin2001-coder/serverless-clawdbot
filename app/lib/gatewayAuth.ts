import crypto from "crypto";
import { getStore } from "@/app/lib/store";
import { env } from "@/app/lib/env";

const PAIR_CODE_KEY = "gateway:pair_code";
const TOKEN_KEY = "gateway:bearer_token";

function randomCode(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export async function ensurePairingCode(): Promise<{ paired: boolean; code?: string }> {
  const store = getStore();

  const token = await store.get<string>(TOKEN_KEY);
  if (token) return { paired: true };

  let code = await store.get<string>(PAIR_CODE_KEY);
  if (!code) {
    code = randomCode();
    await store.set(PAIR_CODE_KEY, code, { exSeconds: 24 * 60 * 60 });
    // eslint-disable-next-line no-console
    console.log(`[zeroclaw-vercel] Pairing code generated: ${code}`);
  }

  return { paired: false, code };
}

export async function getGatewayAuthStatus(): Promise<{ paired: boolean; pairingCode?: string }> {
  const store = getStore();
  const token = await store.get<string>(TOKEN_KEY);
  if (token) return { paired: true };
  const code = await store.get<string>(PAIR_CODE_KEY);
  return { paired: false, pairingCode: code ?? undefined };
}

export async function regenerateGatewayPairingCode(): Promise<string> {
  const store = getStore();
  const code = randomCode();
  await store.set(PAIR_CODE_KEY, code, { exSeconds: 24 * 60 * 60 });
  // eslint-disable-next-line no-console
  console.log(`[zeroclaw-vercel] Pairing code regenerated: ${code}`);
  return code;
}

export async function clearGatewayBearerToken(): Promise<void> {
  const store = getStore();
  await store.del(TOKEN_KEY);
}

export async function exchangePairingCode(provided: string): Promise<string | null> {
  const store = getStore();

  const token = await store.get<string>(TOKEN_KEY);
  if (token) return token;

  const expected = await store.get<string>(PAIR_CODE_KEY);
  if (!expected) return null;
  if (provided !== expected) return null;

  const newToken = crypto.randomUUID();
  await store.set(TOKEN_KEY, newToken);
  await store.del(PAIR_CODE_KEY);
  return newToken;
}

export function getBearerFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice("bearer ".length).trim();

  const alt = req.headers.get("x-openclaw-token") || req.headers.get("x-zeroclaw-token");
  if (alt) return alt.trim();

  return null;
}

export async function verifyGatewayBearer(req: Request): Promise<boolean> {
  const store = getStore();
  const required = await store.get<string>(TOKEN_KEY);

  if (env("GATEWAY_REQUIRE_PAIRING") === "false") return true;

  if (!required) {
    await ensurePairingCode();
    return false;
  }

  const got = getBearerFromRequest(req);
  return !!got && got === required;
}
