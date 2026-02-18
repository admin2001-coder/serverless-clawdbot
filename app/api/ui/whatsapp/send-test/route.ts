/* import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { whatsappSendMessage } from "@/app/lib/providers/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const to = String(form.get("to") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();
  if (!to || !message) return new Response("Missing to/message", { status: 400 });

  await whatsappSendMessage(to, message);

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#whatsapp`, 303);
}
*/