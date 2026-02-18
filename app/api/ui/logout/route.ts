import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { clearUiCookie } from "@/app/lib/uiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const base = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  const res = NextResponse.redirect(`${base.replace(/\/$/, "")}/ui/login`, 303);
  clearUiCookie(res);
  return res;
}
