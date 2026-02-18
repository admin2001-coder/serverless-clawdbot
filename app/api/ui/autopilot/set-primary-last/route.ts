import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { getLastSession } from "@/app/lib/sessionMeta";
import { setPrimary } from "@/app/lib/autopilotState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const last = await getLastSession("any");
  if (!last) return new Response("No last session found. Message the bot once first.", { status: 409 });

  await setPrimary({ channel: last.channel, sessionId: last.sessionId });

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#autopilot`, 303);
}
