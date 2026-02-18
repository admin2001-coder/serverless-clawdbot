import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { makeUiToken, setUiCookie } from "@/app/lib/uiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");

  const expected = env("ADMIN_UI_PASSWORD");
  if (!expected) return new Response("Set ADMIN_UI_PASSWORD first.", { status: 500 });

  const url = new URL(req.url);
  const base = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;

  if (password !== expected) {
    return NextResponse.redirect(`${base.replace(/\/$/, "")}/ui/login?error=1`, 303);
  }

  const token = makeUiToken();
  const res = NextResponse.redirect(`${base.replace(/\/$/, "")}/ui`, 303);
  setUiCookie(res, token);
  return res;
}
