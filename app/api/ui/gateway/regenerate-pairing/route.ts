import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { regenerateGatewayPairingCode } from "@/app/lib/gatewayAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  await regenerateGatewayPairingCode();

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#gateway`, 303);
}
