import { NextResponse } from "next/server";
import { env, envRequired } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const botToken = envRequired("TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    return new Response(`Telegram deleteWebhook failed: ${res.status}\n${body}`, { status: 500 });
  }

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#telegram`, 303);
}
