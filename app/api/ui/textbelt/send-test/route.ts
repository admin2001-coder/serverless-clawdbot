import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { textbeltSendSms, getTextbeltReplyWebhookUrl } from "@/app/lib/providers/textbelt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const to = String(form.get("to") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  if (!to || !message) return new Response("Missing to/message", { status: 400 });

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  const replyWebhookUrl = getTextbeltReplyWebhookUrl(baseUrl);

  const resp = await textbeltSendSms({ to, message, replyWebhookUrl });

  if (!resp.success) {
    return new Response(`Textbelt send failed: ${resp.error ?? "unknown error"}`, { status: 500 });
  }

  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#sms`, 303);
}
