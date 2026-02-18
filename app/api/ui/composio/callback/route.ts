import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;

  // keep whatever Composio sends, then redirect back to UI
  const qs = url.searchParams.toString();
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#composio${qs ? `&${qs}` : ""}`, 303);
}
