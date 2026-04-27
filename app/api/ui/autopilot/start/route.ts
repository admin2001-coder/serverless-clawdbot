import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { setAutopilotEnabled } from "@/app/lib/autopilotState";
import { ensureAutopilotPrimary, startAutopilotIfNeeded } from "@/app/lib/autopilotRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const primary = await ensureAutopilotPrimary();
  if (!primary) {
    return new Response("No primary destination found. Message the bot once first, then start autopilot.", { status: 409 });
  }

  await setAutopilotEnabled(true);
  await startAutopilotIfNeeded("ui");

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#autopilot`, 303);
}
