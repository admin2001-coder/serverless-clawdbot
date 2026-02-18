import { headers } from "next/headers";
import Link from "next/link";
import { requireUiAuthPage } from "@/app/lib/uiRequire";
import { env } from "@/app/lib/env";
import { getGatewayAuthStatus, ensurePairingCode } from "@/app/lib/gatewayAuth";
//import { getTextbeltReplyWebhookUrl } from "@/app/lib/providers/textbelt";
import { getLastSession } from "@/app/lib/sessionMeta";
import { getPrimary, getIntervalSeconds, isAutopilotEnabled } from "@/app/lib/autopilotState";

import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

export const dynamic = "force-dynamic";

async function baseUrlFromHeaders(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

export default async function UiPage({ searchParams }: { searchParams?: Promise<{ userId?: string }> }) {
  const sp = (await searchParams) ?? {};

// after searchParams resolutionconst autopilotEnabled = await isAutopilotEnabled();
const primary = await getPrimary();
const intervalSeconds = await getIntervalSeconds();


let userId: string;

if (sp.userId) {
  userId = sp.userId;
} else {
  const last = await getLastSession("any");
  if (last) {
    userId = `${last.channel}:${last.sessionId.split(":")[1]}`;
  } else {
    userId = "admin";
  }
}
  await requireUiAuthPage();
const baseUrlRaw = env("APP_BASE_URL") ?? await baseUrlFromHeaders();
const normalizedBase = baseUrlRaw.replace(/\/$/, "");

  const gateway = await getGatewayAuthStatus();
  const pairing = gateway.paired ? null : await ensurePairingCode();
  const pairingCode = gateway.paired ? undefined : pairing?.code ?? gateway.pairingCode;


  let composioToolkits: Array<{ slug: string; name?: string; connected: boolean; connectedAccountId?: string }> = [];
  let composioError: string | null = null;

  if (env("COMPOSIO_API_KEY")) {
    try {
      const composio = new Composio({ provider: new VercelProvider() });
      const session: any = await composio.create(userId, { manageConnections: false });
      const toolkits: any = await session.toolkits();
      const items = toolkits?.items ?? toolkits?.toolkits ?? [];
      composioToolkits = (items as any[]).map((t) => {
        const slug = t.slug ?? t.name ?? "unknown";
        const connectedAccountId = t.connection?.connectedAccount?.id ?? t.connection?.connected_account?.id;
        const connected = !!connectedAccountId || !!t.connection?.isActive || !!t.connection?.is_active;
        return { slug, name: t.name, connected, connectedAccountId };
      });
      composioToolkits.sort((a, b) => a.slug.localeCompare(b.slug));
    } catch (e: any) {
      composioError = e?.message ?? String(e);
    }
  } else {
    composioError = "COMPOSIO_API_KEY is not set.";
  }

  const telegramWebhookUrl = `${normalizedBase}/telegram`;
  const whatsappWebhookUrl = `${normalizedBase}/whatsapp`;
  const smsWebhookUrl = `${normalizedBase}/sms`;
  //const smsReplyWebhook = getTextbeltReplyWebhookUrl(normalizedBase);

  return (
    <main style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1>ZeroClaw / OpenClaw Admin UI</h1>
        <form action="/api/ui/logout" method="post">
          <button type="submit" style={{ padding: 8 }}>Logout</button>
        </form>
      </div>

      <p style={{ opacity: 0.85 }}>
        Base URL: <code>{normalizedBase}</code> (set <code>APP_BASE_URL</code> to override)
      </p>

      <hr />

      <section id="gateway">
        <h2>Gateway Auth ( /pair + /webhook )</h2>
        <p>
          /pair URL: <code>{normalizedBase}/pair</code>
          <br />
          /webhook URL: <code>{normalizedBase}/webhook</code>
        </p>

        {gateway.paired ? (
          <p>✅ Gateway is paired (bearer token set).</p>
        ) : (
          <>
            <p>🔐 Gateway is not paired yet.</p>
            <p>
              Pairing code (admin-only): <code>{pairingCode ?? "(not generated yet)"}</code>
            </p>
          </>
        )}

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <form action="/api/ui/gateway/regenerate-pairing" method="post">
            <button type="submit" style={{ padding: 8 }}>Regenerate pairing code</button>
          </form>
          <form action="/api/ui/gateway/clear-token" method="post">
            <button type="submit" style={{ padding: 8 }}>Clear bearer token</button>
          </form>
        </div>
      </section>

      <hr />

      <section id="telegram">
        <h2>Telegram</h2>
        <p>Webhook URL: <code>{telegramWebhookUrl}</code></p>
        <p style={{ fontSize: 14, opacity: 0.85 }}>
          Env required: <code>TELEGRAM_BOT_TOKEN</code>. Optional: <code>TELEGRAM_WEBHOOK_SECRET</code>.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <form action="/api/ui/telegram/set-webhook" method="post">
            <button type="submit" style={{ padding: 8 }}>Set Telegram webhook</button>
          </form>
          <form action="/api/ui/telegram/delete-webhook" method="post">
            <button type="submit" style={{ padding: 8 }}>Delete Telegram webhook</button>
          </form>
        </div>
      </section>

      <hr />

      <section id="whatsapp">
        <h2>WhatsApp Cloud API</h2>
        <p>
          Webhook URL: <code>{whatsappWebhookUrl}</code>
          <br />
          Verify token: <code>{env("WHATSAPP_VERIFY_TOKEN") ?? "(set WHATSAPP_VERIFY_TOKEN)"}</code>
        </p>
        <p style={{ fontSize: 14, opacity: 0.85 }}>
          Env required: <code>WHATSAPP_ACCESS_TOKEN</code>, <code>WHATSAPP_PHONE_NUMBER_ID</code>, <code>WHATSAPP_VERIFY_TOKEN</code>.
        </p>

        <h3>Send test message</h3>
        <form action="/api/ui/whatsapp/send-test" method="post" style={{ display: "grid", gap: 10, maxWidth: 520 }}>
          <label>
            To (E.164)
            <input name="to" placeholder="+15551234567" style={{ width: "100%", padding: 8, marginTop: 6 }} />
          </label>
          <label>
            Message
            <input name="message" placeholder="Hello from the bot" style={{ width: "100%", padding: 8, marginTop: 6 }} />
          </label>
          <button type="submit" style={{ padding: 10 }}>Send WhatsApp test</button>
        </form>
      </section>

      <hr />

      <section id="sms">
        <h2>SMS (Textbelt)</h2>
        <p>
          Reply webhook URL (included automatically in outgoing SMS when possible):{" "}
          <br />
          Inbound endpoint (Textbelt replies POST here): <code>{smsWebhookUrl}</code>
        </p>
        <p style={{ fontSize: 14, opacity: 0.85 }}>
          Notes:
          <br />• Textbelt can receive SMS only as <b>replies</b> to texts you send (U.S. phone numbers only).
          <br />• SMS replies do <b>not</b> work on the free <code>textbelt</code> key.
          <br />• Set <code>TEXTBELT_API_KEY</code> and preferably <code>APP_BASE_URL</code>.
        </p>

        <h3>Send test SMS</h3>
        <form action="/api/ui/textbelt/send-test" method="post" style={{ display: "grid", gap: 10, maxWidth: 520 }}>
          <label>
            To (E.164)
            <input name="to" placeholder="+15551234567" style={{ width: "100%", padding: 8, marginTop: 6 }} />
          </label>
          <label>
            Message
            <input name="message" placeholder="Reply to this SMS to chat with the bot" style={{ width: "100%", padding: 8, marginTop: 6 }} />
          </label>
          <button type="submit" style={{ padding: 10 }}>Send SMS test</button>
        </form>
      </section>

<hr />

<section id="autopilot">
  <h2>Autopilot (Proactive Messaging)</h2>

  <p>
    Status: {await isAutopilotEnabled() ? <b>✅ enabled</b> : <b>⛔ disabled</b>}
    <br />
    Primary destination:{" "}
    <code>{primary ? `${primary.channel} / ${primary.sessionId}` : "(not set yet)"}</code>
    <br />
    Interval: <code>{intervalSeconds}s</code>
  </p>

  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
    <form action="/api/ui/autopilot/set-primary-last" method="post">
      <button type="submit" style={{ padding: 8 }}>Use last chat as primary</button>
    </form>

    <form action="/api/ui/autopilot/start" method="post">
      <button type="submit" style={{ padding: 8 }}>Start Autopilot</button>
    </form>

    <form action="/api/ui/autopilot/stop" method="post">
      <button type="submit" style={{ padding: 8 }}>Stop Autopilot</button>
    </form>
  </div>

  <div style={{ marginTop: 12 }}>
    <form action="/api/ui/autopilot/set-interval" method="post" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <label>
        Interval seconds (5..86400)
        <input name="seconds" defaultValue={intervalSeconds} style={{ width: 180, padding: 8, marginTop: 6 }} />
      </label>
      <button type="submit" style={{ padding: 10 }}>Update interval</button>
    </form>
  </div>

  <p style={{ fontSize: 13, opacity: 0.8, marginTop: 10 }}>
    Telegram note: you must message the bot once (e.g. <code>/start</code>) before it can DM you.
  </p>
</section>

      <section id="composio">
        <h2>Integrations (Composio)</h2>
        <p style={{ fontSize: 14, opacity: 0.85 }}>
          Connect toolkits using Composio Connect Links (hosted auth).
        </p>

        <form method="get" action="/ui" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label>
            Composio userId (must match your chat identity for tool access)
            <input
              name="userId"
              defaultValue={userId}
              placeholder="telegram:123456789"
              style={{ width: 360, padding: 8, marginTop: 6 }}
            />
          </label>
          <button type="submit" style={{ padding: 10 }}>Load</button>
        </form>

        {composioError ? (
          <p style={{ color: "crimson" }}>{composioError}</p>
        ) : (
          <>
            <p style={{ marginTop: 12 }}>
              Loaded {composioToolkits.length} toolkits for <code>{userId}</code>.
            </p>

            <details style={{ marginTop: 12 }}>
              <summary>Connect a toolkit by slug</summary>
              <form
                action="/api/ui/composio/authorize"
                method="get"
                style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}
              >
                <input type="hidden" name="userId" value={userId} />
                <label>
                  Toolkit slug
                  <input name="toolkit" placeholder="gmail" style={{ width: 200, padding: 8, marginTop: 6 }} />
                </label>
                <button type="submit" style={{ padding: 10 }}>Connect</button>
              </form>
            </details>

            <div style={{ marginTop: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>Toolkit</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>Status</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {composioToolkits.slice(0, 50).map((t) => (
                    <tr key={t.slug}>
                      <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>
                        <code>{t.slug}</code>
                        {t.name ? <span style={{ marginLeft: 8, opacity: 0.8 }}>{t.name}</span> : null}
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>
                        {t.connected ? (
                          <span>✅ connected {t.connectedAccountId ? <code>{t.connectedAccountId}</code> : null}</span>
                        ) : (
                          <span>❌ not connected</span>
                        )}
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>
                        <Link
                          href={`/api/ui/composio/authorize?userId=${encodeURIComponent(userId)}&toolkit=${encodeURIComponent(
                            t.slug
                          )}`}
                        >
                          Connect
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {composioToolkits.length > 50 ? (
                <p style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
                  Showing first 50 toolkits. Use “Connect by slug” above for others.
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      <hr />

      <p style={{ fontSize: 13, opacity: 0.75 }}>
        Helpful endpoints: <Link href="/health">/health</Link>, <Link href="/telegram">/telegram</Link>,{" "}
        <Link href="/whatsapp">/whatsapp</Link>, <Link href="/sms">/sms</Link>, <Link href="/ui/login">/ui/login</Link>
      </p>
    </main>
  );
}
