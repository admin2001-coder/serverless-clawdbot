import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { setIntervalSeconds } from "@/app/lib/autopilotState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const seconds = Number(form.get("seconds") ?? "300");

  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) {
    return new Response("Invalid seconds (5..86400)", { status: 400 });
  }

  await setIntervalSeconds(seconds);

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#autopilot`, 303);
}
