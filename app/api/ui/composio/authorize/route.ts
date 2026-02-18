import { NextResponse } from "next/server";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { env } from "@/app/lib/env";

import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const composio = new Composio({ provider: new VercelProvider() });

export async function GET(req: Request) {
  const ok = await verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  if (!env("COMPOSIO_API_KEY")) {
    return new Response("Set COMPOSIO_API_KEY first.", { status: 500 });
  }

  const url = new URL(req.url);
  const toolkit = url.searchParams.get("toolkit") ?? "";
  const userId = url.searchParams.get("userId") ?? "admin";
  if (!toolkit) return new Response("Missing toolkit", { status: 400 });

  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
const callbackUrl = `${baseUrl.replace(/\/$/, "")}/api/ui/composio/callback?userId=${encodeURIComponent(userId)}&toolkit=${encodeURIComponent(toolkit)}`;


  const session: any = await composio.create(userId, { manageConnections: false });
  const connectionRequest: any = await session.authorize(toolkit, { callbackUrl });

  const redirectUrl = connectionRequest.redirectUrl ?? connectionRequest.redirect_url;
  if (!redirectUrl) return new Response("Composio authorize() did not return redirectUrl", { status: 500 });

  return NextResponse.redirect(String(redirectUrl), 307);
}
