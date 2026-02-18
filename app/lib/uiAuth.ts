// app/lib/uiAuth.ts
import crypto from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";

const COOKIE_NAME = "claw_ui";

function secret(): string {
  const s = env("ADMIN_UI_PASSWORD");
  if (!s) throw new Error("Set ADMIN_UI_PASSWORD");
  return s;
}

function base64url(input: string) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sign(dataB64: string) {
  return crypto
    .createHmac("sha256", secret())
    .update(dataB64)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function makeUiToken(ttlSeconds = 12 * 60 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadB64 = base64url(JSON.stringify({ exp }));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifyUiToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;

  const expected = sign(payloadB64);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch {
    return false;
  }

  try {
    const json = JSON.parse(Buffer.from(payloadB64.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
    const exp = Number(json.exp);
    if (!Number.isFinite(exp)) return false;
    return Math.floor(Date.now() / 1000) < exp;
  } catch {
    return false;
  }
}

export async function getUiCookie(): Promise<string | null> {
  const c = await cookies();
  return c.get(COOKIE_NAME)?.value ?? null;
}

export function setUiCookie(res: NextResponse, token: string) {
  res.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
}

export function clearUiCookie(res: NextResponse) {
  res.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
