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

type SearchParams = {
  userId?: string;
  tab?: string;
};

type TabKey = "integrations" | "overview" | "deployments" | "gateway" | "channels" | "autopilot" | "settings";

function formatToolkitName(slug: string, name?: string) {
  if (name && name.trim()) return name;
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function statusPill(connected: boolean) {
  return connected
    ? {
        text: "Ready",
        fg: "#0070f3",
        bg: "rgba(0,112,243,0.08)",
        border: "rgba(0,112,243,0.18)",
      }
    : {
        text: "Not Connected",
        fg: "#666",
        bg: "rgba(0,0,0,0.04)",
        border: "rgba(0,0,0,0.08)",
      };
}

function maskId(id?: string) {
  if (!id) return "";
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export default async function UiPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const sp = (await searchParams) ?? {};

  await requireUiAuthPage();

  const autopilotEnabled = await isAutopilotEnabled();
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

  const activeTab: TabKey = (() => {
    const raw = sp.tab;
    if (
      raw === "integrations" ||
      raw === "overview" ||
      raw === "deployments" ||
      raw === "gateway" ||
      raw === "channels" ||
      raw === "autopilot" ||
      raw === "settings"
    ) {
      return raw;
    }
    return "integrations";
  })();

  const baseUrlRaw = env("APP_BASE_URL") ?? (await baseUrlFromHeaders());
  const normalizedBase = baseUrlRaw.replace(/\/$/, "");

  const gateway = await getGatewayAuthStatus();
  const pairing = gateway.paired ? null : await ensurePairingCode();
  const pairingCode = gateway.paired ? undefined : pairing?.code ?? gateway.pairingCode;

  let composioToolkits: Array<{
    slug: string;
    name?: string;
    connected: boolean;
    connectedAccountId?: string;
  }> = [];
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
      composioToolkits.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return a.slug.localeCompare(b.slug);
      });
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

  const totalToolkits = composioToolkits.length;
  const connectedToolkits = composioToolkits.filter((t) => t.connected).length;
  const disconnectedToolkits = totalToolkits - connectedToolkits;

  const navHref = (tab: TabKey) =>
    `/ui?tab=${encodeURIComponent(tab)}&userId=${encodeURIComponent(userId)}`;

  const integrations = composioToolkits.slice(0, 24);

  return (
    <main style={styles.shell}>
      <div style={styles.chromeTopBar}>
        <div style={styles.chromeBrand}>
          <div style={styles.chromeLogo}>▲</div>
          <div>
            <div style={styles.chromeTitle}>ZeroClaw</div>
            <div style={styles.chromeSubtitle}>Admin Dashboard</div>
          </div>
        </div>

        <div style={styles.chromeActions}>
          <form method="get" action="/ui" style={styles.inlineForm}>
            <input type="hidden" name="tab" value={activeTab} />
            <input
              name="userId"
              defaultValue={userId}
              placeholder="telegram:123456789"
              style={styles.userIdInput}
            />
            <button type="submit" style={styles.blackButton}>
              Load User
            </button>
          </form>

          <form action="/api/ui/logout" method="post">
            <button type="submit" style={styles.blackButton}>
              Logout
            </button>
          </form>
        </div>
      </div>

      <div style={styles.appFrame}>
        <aside style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            <div style={styles.sidebarLogo}>▲</div>
            <div>
              <div style={styles.sidebarTitle}>ZeroClaw</div>
              <div style={styles.sidebarMeta}>OpenClaw Control Plane</div>
            </div>
          </div>

          <nav style={styles.nav}>
            <Link href={navHref("integrations")} style={activeTab === "integrations" ? styles.navItemActive : styles.navItem}>
              Integrations
            </Link>
            <Link href={navHref("overview")} style={activeTab === "overview" ? styles.navItemActive : styles.navItem}>
              Overview
            </Link>
            <Link href={navHref("deployments")} style={activeTab === "deployments" ? styles.navItemActive : styles.navItem}>
              Deployments
            </Link>
            <Link href={navHref("gateway")} style={activeTab === "gateway" ? styles.navItemActive : styles.navItem}>
              Gateway
            </Link>
            <Link href={navHref("channels")} style={activeTab === "channels" ? styles.navItemActive : styles.navItem}>
              Channels
            </Link>
            <Link href={navHref("autopilot")} style={activeTab === "autopilot" ? styles.navItemActive : styles.navItem}>
              Autopilot
            </Link>
            <Link href={navHref("settings")} style={activeTab === "settings" ? styles.navItemActive : styles.navItem}>
              Settings
            </Link>
          </nav>

          <div style={styles.sidebarFooter}>
            <div style={styles.sidebarFooterLabel}>Base URL</div>
            <code style={styles.sidebarCode}>{normalizedBase}</code>
          </div>
        </aside>

        <section style={styles.content}>
          <div style={styles.contentHeader}>
            <div>
              <h1 style={styles.pageTitle}>
                {activeTab === "integrations" && "Connected Integrations"}
                {activeTab === "overview" && "Overview"}
                {activeTab === "deployments" && "Deployments"}
                {activeTab === "gateway" && "Gateway"}
                {activeTab === "channels" && "Channels"}
                {activeTab === "autopilot" && "Autopilot"}
                {activeTab === "settings" && "Settings"}
              </h1>
              <p style={styles.pageSubtitle}>
                {activeTab === "integrations" &&
                  "Vercel-inspired deployment cards now represent Composio integrations for the selected identity."}
                {activeTab === "overview" &&
                  "Operational summary for routing, pairing, connected integrations, and proactive messaging."}
                {activeTab === "deployments" &&
                  "System endpoints and internal routes grouped in a deployment-style index."}
                {activeTab === "gateway" &&
                  "Pairing and bearer-token controls for gateway access."}
                {activeTab === "channels" &&
                  "Webhook configuration and test controls for Telegram, WhatsApp, and SMS."}
                {activeTab === "autopilot" &&
                  "Primary destination and proactive messaging controls."}
                {activeTab === "settings" &&
                  "Composio identity loading and direct toolkit authorization."}
              </p>
            </div>

            <div style={styles.topRightMeta}>
              <div style={styles.metaStat}>
                <div style={styles.metaLabel}>Identity</div>
                <code style={styles.metaCode}>{userId}</code>
              </div>
            </div>
          </div>

          <div style={styles.tabsRow}>
            <Link href={navHref("integrations")} style={activeTab === "integrations" ? styles.tabActive : styles.tab}>
              Integrations
            </Link>
            <Link href={navHref("overview")} style={activeTab === "overview" ? styles.tabActive : styles.tab}>
              Overview
            </Link>
            <Link href={navHref("deployments")} style={activeTab === "deployments" ? styles.tabActive : styles.tab}>
              Deployments
            </Link>
            <Link href={navHref("gateway")} style={activeTab === "gateway" ? styles.tabActive : styles.tab}>
              Gateway
            </Link>
            <Link href={navHref("channels")} style={activeTab === "channels" ? styles.tabActive : styles.tab}>
              Channels
            </Link>
            <Link href={navHref("autopilot")} style={activeTab === "autopilot" ? styles.tabActive : styles.tab}>
              Autopilot
            </Link>
            <Link href={navHref("settings")} style={activeTab === "settings" ? styles.tabActive : styles.tab}>
              Settings
            </Link>
          </div>

          {activeTab === "integrations" ? (
            <>
              <div style={styles.summaryGrid}>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Connected</div>
                  <div style={styles.summaryValue}>{connectedToolkits}</div>
                </div>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Available</div>
                  <div style={styles.summaryValue}>{totalToolkits}</div>
                </div>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Pending</div>
                  <div style={styles.summaryValue}>{disconnectedToolkits}</div>
                </div>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Gateway</div>
                  <div style={styles.summaryValueSmall}>{gateway.paired ? "Paired" : "Unpaired"}</div>
                </div>
              </div>

              {composioError ? (
                <div style={styles.calloutError}>{composioError}</div>
              ) : (
                <>
                  <div style={styles.cardsGrid}>
                    {integrations.map((t) => {
                      const pill = statusPill(t.connected);
                      return (
                        <article key={t.slug} style={styles.integrationCard}>
                          <div style={styles.integrationCardHeader}>
                            <div>
                              <div style={styles.integrationTitle}>{formatToolkitName(t.slug, t.name)}</div>
                              <div style={styles.integrationSlug}>{t.slug}</div>
                            </div>
                            <div
                              style={{
                                ...styles.statusTag,
                                color: pill.fg,
                                background: pill.bg,
                                borderColor: pill.border,
                              }}
                            >
                              {pill.text}
                            </div>
                          </div>

                          <div style={styles.integrationMetaRow}>
                            <div style={styles.miniMetric}>
                              <div style={styles.miniMetricLabel}>Account</div>
                              <div style={styles.miniMetricValue}>
                                {t.connectedAccountId ? maskId(t.connectedAccountId) : "—"}
                              </div>
                            </div>
                            <div style={styles.miniMetric}>
                              <div style={styles.miniMetricLabel}>Type</div>
                              <div style={styles.miniMetricValue}>Composio</div>
                            </div>
                          </div>

                          <div style={styles.integrationFooter}>
                            <Link
                              href={`/api/ui/composio/authorize?userId=${encodeURIComponent(userId)}&toolkit=${encodeURIComponent(
                                t.slug
                              )}`}
                              style={styles.integrationAction}
                            >
                              {t.connected ? "Reconnect" : "Connect"}
                            </Link>
                          </div>
                        </article>
                      );
                    })}
                  </div>

                  <div style={styles.listCard}>
                    <div style={styles.listHeader}>
                      <div>
                        <div style={styles.listTitle}>All integrations</div>
                        <div style={styles.listSubtitle}>
                          Full toolkit list for <code>{userId}</code>
                        </div>
                      </div>

                      <details>
                        <summary style={styles.inlineSummary}>Connect by slug</summary>
                        <form
                          action="/api/ui/composio/authorize"
                          method="get"
                          style={styles.compactConnectForm}
                        >
                          <input type="hidden" name="userId" value={userId} />
                          <input name="toolkit" placeholder="gmail" style={styles.inlineInput} />
                          <button type="submit" style={styles.blackButtonSmall}>
                            Connect
                          </button>
                        </form>
                      </details>
                    </div>

                    <div style={styles.tableWrap}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Name</th>
                            <th style={styles.th}>Slug</th>
                            <th style={styles.th}>Status</th>
                            <th style={styles.th}>Account</th>
                            <th style={styles.th}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {composioToolkits.slice(0, 50).map((t) => (
                            <tr key={t.slug}>
                              <td style={styles.tdStrong}>{formatToolkitName(t.slug, t.name)}</td>
                              <td style={styles.td}>
                                <code>{t.slug}</code>
                              </td>
                              <td style={styles.td}>{t.connected ? "Connected" : "Not connected"}</td>
                              <td style={styles.td}>
                                {t.connectedAccountId ? <code>{maskId(t.connectedAccountId)}</code> : "—"}
                              </td>
                              <td style={styles.td}>
                                <Link
                                  href={`/api/ui/composio/authorize?userId=${encodeURIComponent(
                                    userId
                                  )}&toolkit=${encodeURIComponent(t.slug)}`}
                                  style={styles.tableLink}
                                >
                                  {t.connected ? "Reconnect" : "Connect"}
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {composioToolkits.length > 50 ? (
                      <p style={styles.footnote}>
                        Showing first 50 toolkits. Use the direct connect control above for additional slugs.
                      </p>
                    ) : null}
                  </div>
                </>
              )}
            </>
          ) : null}

          {activeTab === "overview" ? (
            <>
              <div style={styles.summaryGrid}>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Gateway</div>
                  <div style={styles.summaryValueSmall}>{gateway.paired ? "Paired" : "Needs pairing"}</div>
                </div>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Autopilot</div>
                  <div style={styles.summaryValueSmall}>{autopilotEnabled ? "Enabled" : "Disabled"}</div>
                </div>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Primary</div>
                  <div style={styles.summaryValueTiny}>{primary ? `${primary.channel} / ${primary.sessionId}` : "Not set"}</div>
                </div>
                <div style={styles.summaryCard}>
                  <div style={styles.summaryLabel}>Interval</div>
                  <div style={styles.summaryValueSmall}>{intervalSeconds}s</div>
                </div>
              </div>

              <div style={styles.listCard}>
                <div style={styles.sectionTitle}>Recent platform overview</div>
                <div style={styles.overviewGrid}>
                  <div style={styles.infoPanel}>
                    <div style={styles.infoPanelTitle}>Endpoints</div>
                    <ul style={styles.cleanList}>
                      <li>
                        <code>{normalizedBase}/health</code>
                      </li>
                      <li>
                        <code>{normalizedBase}/telegram</code>
                      </li>
                      <li>
                        <code>{normalizedBase}/whatsapp</code>
                      </li>
                      <li>
                        <code>{normalizedBase}/sms</code>
                      </li>
                      <li>
                        <code>{normalizedBase}/webhook</code>
                      </li>
                      <li>
                        <code>{normalizedBase}/pair</code>
                      </li>
                    </ul>
                  </div>

                  <div style={styles.infoPanel}>
                    <div style={styles.infoPanelTitle}>Composio</div>
                    {composioError ? (
                      <p style={styles.mutedText}>{composioError}</p>
                    ) : (
                      <ul style={styles.cleanList}>
                        <li>Identity: <code>{userId}</code></li>
                        <li>Total toolkits: {totalToolkits}</li>
                        <li>Connected: {connectedToolkits}</li>
                        <li>Pending: {disconnectedToolkits}</li>
                      </ul>
                    )}
                  </div>

                  <div style={styles.infoPanel}>
                    <div style={styles.infoPanelTitle}>Channels</div>
                    <ul style={styles.cleanList}>
                      <li>Telegram webhook ready at <code>/telegram</code></li>
                      <li>WhatsApp webhook ready at <code>/whatsapp</code></li>
                      <li>Textbelt replies handled at <code>/sms</code></li>
                    </ul>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {activeTab === "deployments" ? (
            <div style={styles.listCard}>
              <div style={styles.listHeader}>
                <div>
                  <div style={styles.listTitle}>Deployment endpoints</div>
                  <div style={styles.listSubtitle}>Dashboard routes and webhook surfaces</div>
                </div>
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Route</th>
                      <th style={styles.th}>Purpose</th>
                      <th style={styles.th}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={styles.tdStrong}><code>/health</code></td>
                      <td style={styles.td}>Health check</td>
                      <td style={styles.td}>Operational status endpoint</td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/ui</code></td>
                      <td style={styles.td}>Admin UI</td>
                      <td style={styles.td}>Primary operator console</td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/telegram</code></td>
                      <td style={styles.td}>Telegram webhook</td>
                      <td style={styles.td}>Requires <code>TELEGRAM_BOT_TOKEN</code></td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/whatsapp</code></td>
                      <td style={styles.td}>WhatsApp webhook</td>
                      <td style={styles.td}>Requires Meta Cloud API envs</td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/sms</code></td>
                      <td style={styles.td}>Textbelt inbound replies</td>
                      <td style={styles.td}>Reply-only inbound pattern</td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/pair</code></td>
                      <td style={styles.td}>Pairing URL</td>
                      <td style={styles.td}>Gateway pairing bootstrap</td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/webhook</code></td>
                      <td style={styles.td}>Internal webhook</td>
                      <td style={styles.td}>Gateway internal callback surface</td>
                    </tr>
                    <tr>
                      <td style={styles.tdStrong}><code>/ui/login</code></td>
                      <td style={styles.td}>Admin login</td>
                      <td style={styles.td}>Protected UI access</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {activeTab === "gateway" ? (
            <div style={styles.formGrid}>
              <section style={styles.panel}>
                <div style={styles.sectionTitle}>Gateway Auth</div>
                <p style={styles.mutedText}>
                  Pair URL: <code>{normalizedBase}/pair</code>
                  <br />
                  Webhook URL: <code>{normalizedBase}/webhook</code>
                </p>

                {gateway.paired ? (
                  <div style={styles.calloutOk}>Gateway is paired and bearer token is set.</div>
                ) : (
                  <div style={styles.calloutWarn}>
                    Gateway is not paired yet.
                    <br />
                    Pairing code: <code>{pairingCode ?? "(not generated yet)"}</code>
                  </div>
                )}

                <div style={styles.buttonRow}>
                  <form action="/api/ui/gateway/regenerate-pairing" method="post">
                    <button type="submit" style={styles.blackButtonSmall}>
                      Regenerate pairing code
                    </button>
                  </form>
                  <form action="/api/ui/gateway/clear-token" method="post">
                    <button type="submit" style={styles.whiteButtonSmall}>
                      Clear bearer token
                    </button>
                  </form>
                </div>
              </section>
            </div>
          ) : null}

          {activeTab === "channels" ? (
            <div style={styles.formGrid}>
              <section style={styles.panel}>
                <div style={styles.sectionTitle}>Telegram</div>
                <p style={styles.mutedText}>
                  Webhook URL: <code>{telegramWebhookUrl}</code>
                </p>
                <p style={styles.footnote}>
                  Env required: <code>TELEGRAM_BOT_TOKEN</code>. Optional: <code>TELEGRAM_WEBHOOK_SECRET</code>.
                </p>
                <div style={styles.buttonRow}>
                  <form action="/api/ui/telegram/set-webhook" method="post">
                    <button type="submit" style={styles.blackButtonSmall}>
                      Set Telegram webhook
                    </button>
                  </form>
                  <form action="/api/ui/telegram/delete-webhook" method="post">
                    <button type="submit" style={styles.whiteButtonSmall}>
                      Delete Telegram webhook
                    </button>
                  </form>
                </div>
              </section>

              <section style={styles.panel}>
                <div style={styles.sectionTitle}>WhatsApp Cloud API</div>
                <p style={styles.mutedText}>
                  Webhook URL: <code>{whatsappWebhookUrl}</code>
                  <br />
                  Verify token: <code>{env("WHATSAPP_VERIFY_TOKEN") ?? "(set WHATSAPP_VERIFY_TOKEN)"}</code>
                </p>
                <p style={styles.footnote}>
                  Env required: <code>WHATSAPP_ACCESS_TOKEN</code>, <code>WHATSAPP_PHONE_NUMBER_ID</code>,{" "}
                  <code>WHATSAPP_VERIFY_TOKEN</code>.
                </p>

                <form action="/api/ui/whatsapp/send-test" method="post" style={styles.formStack}>
                  <label style={styles.label}>
                    <span>To (E.164)</span>
                    <input name="to" placeholder="+15551234567" style={styles.input} />
                  </label>
                  <label style={styles.label}>
                    <span>Message</span>
                    <input name="message" placeholder="Hello from the bot" style={styles.input} />
                  </label>
                  <button type="submit" style={styles.blackButtonSmall}>
                    Send WhatsApp test
                  </button>
                </form>
              </section>

              <section style={styles.panel}>
                <div style={styles.sectionTitle}>SMS (Textbelt)</div>
                <p style={styles.mutedText}>
                  Inbound endpoint for replies: <code>{smsWebhookUrl}</code>
                </p>
                <p style={styles.footnote}>
                  Notes:
                  <br />• Textbelt can receive SMS only as replies to texts you send.
                  <br />• SMS replies do not work on the free <code>textbelt</code> key.
                  <br />• Set <code>TEXTBELT_API_KEY</code> and preferably <code>APP_BASE_URL</code>.
                </p>

                <form action="/api/ui/textbelt/send-test" method="post" style={styles.formStack}>
                  <label style={styles.label}>
                    <span>To (E.164)</span>
                    <input name="to" placeholder="+15551234567" style={styles.input} />
                  </label>
                  <label style={styles.label}>
                    <span>Message</span>
                    <input
                      name="message"
                      placeholder="Reply to this SMS to chat with the bot"
                      style={styles.input}
                    />
                  </label>
                  <button type="submit" style={styles.blackButtonSmall}>
                    Send SMS test
                  </button>
                </form>
              </section>
            </div>
          ) : null}

          {activeTab === "autopilot" ? (
            <div style={styles.formGrid}>
              <section style={styles.panel}>
                <div style={styles.sectionTitle}>Autopilot (Proactive Messaging)</div>
                <p style={styles.mutedText}>
                  Status: {autopilotEnabled ? <b>Enabled</b> : <b>Disabled</b>}
                  <br />
                  Primary destination:{" "}
                  <code>{primary ? `${primary.channel} / ${primary.sessionId}` : "(not set yet)"}</code>
                  <br />
                  Interval: <code>{intervalSeconds}s</code>
                </p>

                <div style={styles.buttonRow}>
                  <form action="/api/ui/autopilot/set-primary-last" method="post">
                    <button type="submit" style={styles.blackButtonSmall}>
                      Use last chat as primary
                    </button>
                  </form>

                  <form action="/api/ui/autopilot/start" method="post">
                    <button type="submit" style={styles.blackButtonSmall}>
                      Start Autopilot
                    </button>
                  </form>

                  <form action="/api/ui/autopilot/stop" method="post">
                    <button type="submit" style={styles.whiteButtonSmall}>
                      Stop Autopilot
                    </button>
                  </form>
                </div>

                <div style={{ marginTop: 16 }}>
                  <form action="/api/ui/autopilot/set-interval" method="post" style={styles.intervalForm}>
                    <label style={styles.labelCompact}>
                      <span>Interval seconds (5..86400)</span>
                      <input name="seconds" defaultValue={intervalSeconds} style={styles.inputSmall} />
                    </label>
                    <button type="submit" style={styles.blackButtonSmall}>
                      Update interval
                    </button>
                  </form>
                </div>

                <p style={styles.footnote}>
                  Telegram note: the user must message the bot once, such as <code>/start</code>, before the bot can DM them.
                </p>
              </section>
            </div>
          ) : null}

          {activeTab === "settings" ? (
            <div style={styles.formGrid}>
              <section style={styles.panel}>
                <div style={styles.sectionTitle}>Composio identity</div>
                <form method="get" action="/ui" style={styles.formStack}>
                  <input type="hidden" name="tab" value="integrations" />
                  <label style={styles.label}>
                    <span>Composio userId</span>
                    <input
                      name="userId"
                      defaultValue={userId}
                      placeholder="telegram:123456789"
                      style={styles.input}
                    />
                  </label>
                  <button type="submit" style={styles.blackButtonSmall}>
                    Load integrations
                  </button>
                </form>
                <p style={styles.footnote}>
                  This identity must match your chat identity for tool access.
                </p>
              </section>

              <section style={styles.panel}>
                <div style={styles.sectionTitle}>Helpful endpoints</div>
                <p style={styles.mutedText}>
                  <Link href="/health" style={styles.inlineLink}>/health</Link>,{" "}
                  <Link href="/telegram" style={styles.inlineLink}>/telegram</Link>,{" "}
                  <Link href="/whatsapp" style={styles.inlineLink}>/whatsapp</Link>,{" "}
                  <Link href="/sms" style={styles.inlineLink}>/sms</Link>,{" "}
                  <Link href="/ui/login" style={styles.inlineLink}>/ui/login</Link>
                </p>
              </section>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100vh",
    background: "#fafafa",
    color: "#111",
    padding: 16,
    fontFamily:
      'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  },

  chromeTopBar: {
    height: 44,
    border: "1px solid #eaeaea",
    borderRadius: 10,
    background: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 12px",
    marginBottom: 12,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    gap: 12,
    flexWrap: "wrap",
  },

  chromeBrand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  chromeLogo: {
    width: 22,
    height: 22,
    borderRadius: 999,
    background: "#111",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontSize: 10,
    fontWeight: 700,
  },

  chromeTitle: {
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.1,
  },

  chromeSubtitle: {
    fontSize: 11,
    color: "#666",
    lineHeight: 1.1,
  },

  chromeActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },

  inlineForm: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },

  userIdInput: {
    height: 32,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: "0 10px",
    minWidth: 220,
    fontSize: 13,
    outline: "none",
    background: "#fff",
  },

  blackButton: {
    height: 32,
    borderRadius: 8,
    border: "1px solid #111",
    background: "#111",
    color: "#fff",
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },

  blackButtonSmall: {
    height: 34,
    borderRadius: 8,
    border: "1px solid #111",
    background: "#111",
    color: "#fff",
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },

  whiteButtonSmall: {
    height: 34,
    borderRadius: 8,
    border: "1px solid #e5e5e5",
    background: "#fff",
    color: "#111",
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },

  appFrame: {
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr)",
    border: "1px solid #eaeaea",
    borderRadius: 12,
    overflow: "hidden",
    background: "#fff",
    minHeight: "calc(100vh - 88px)",
  },

  sidebar: {
    borderRight: "1px solid #eaeaea",
    background: "#fff",
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },

  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 4px 10px 4px",
  },

  sidebarLogo: {
    width: 28,
    height: 28,
    borderRadius: 999,
    background: "#111",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
  },

  sidebarTitle: {
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.1,
  },

  sidebarMeta: {
    fontSize: 11,
    color: "#666",
    lineHeight: 1.1,
  },

  nav: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },

  navItem: {
    textDecoration: "none",
    color: "#444",
    fontSize: 13,
    borderRadius: 8,
    padding: "8px 10px",
  },

  navItemActive: {
    textDecoration: "none",
    color: "#111",
    fontSize: 13,
    borderRadius: 8,
    padding: "8px 10px",
    background: "#f5f5f5",
    fontWeight: 600,
  },

  sidebarFooter: {
    marginTop: "auto",
    paddingTop: 12,
    borderTop: "1px solid #f0f0f0",
  },

  sidebarFooterLabel: {
    fontSize: 11,
    color: "#888",
    marginBottom: 6,
  },

  sidebarCode: {
    display: "block",
    fontSize: 11,
    color: "#444",
    wordBreak: "break-all",
  },

  content: {
    padding: 20,
    background: "#fff",
  },

  contentHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 12,
    flexWrap: "wrap",
  },

  pageTitle: {
    fontSize: 24,
    lineHeight: 1.1,
    letterSpacing: -0.4,
    margin: 0,
    fontWeight: 600,
  },

  pageSubtitle: {
    margin: "8px 0 0 0",
    color: "#666",
    fontSize: 13,
    maxWidth: 760,
    lineHeight: 1.5,
  },

  topRightMeta: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },

  metaStat: {
    border: "1px solid #eaeaea",
    borderRadius: 10,
    padding: "10px 12px",
    minWidth: 180,
  },

  metaLabel: {
    fontSize: 11,
    color: "#888",
    marginBottom: 4,
  },

  metaCode: {
    fontSize: 12,
    color: "#111",
    wordBreak: "break-all",
  },

  tabsRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    borderBottom: "1px solid #efefef",
    marginBottom: 18,
    overflowX: "auto",
    paddingBottom: 1,
  },

  tab: {
    textDecoration: "none",
    color: "#666",
    fontSize: 13,
    padding: "10px 12px",
    borderRadius: 8,
    whiteSpace: "nowrap",
  },

  tabActive: {
    textDecoration: "none",
    color: "#111",
    fontSize: 13,
    padding: "10px 12px",
    borderRadius: 8,
    background: "#f6f6f6",
    whiteSpace: "nowrap",
    fontWeight: 600,
  },

  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 12,
    marginBottom: 18,
  },

  summaryCard: {
    border: "1px solid #eaeaea",
    borderRadius: 12,
    padding: 14,
    background: "#fff",
    minHeight: 92,
  },

  summaryLabel: {
    fontSize: 12,
    color: "#777",
    marginBottom: 10,
  },

  summaryValue: {
    fontSize: 28,
    fontWeight: 600,
    letterSpacing: -0.4,
  },

  summaryValueSmall: {
    fontSize: 18,
    fontWeight: 600,
    letterSpacing: -0.2,
  },

  summaryValueTiny: {
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.5,
    wordBreak: "break-word",
  },

  calloutError: {
    border: "1px solid rgba(220,38,38,0.15)",
    background: "rgba(220,38,38,0.06)",
    color: "#b91c1c",
    borderRadius: 12,
    padding: 14,
    fontSize: 13,
  },

  cardsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 14,
    marginBottom: 18,
  },

  integrationCard: {
    border: "1px solid #eaeaea",
    borderRadius: 14,
    padding: 16,
    background: "#fff",
    display: "flex",
    flexDirection: "column",
    minHeight: 180,
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },

  integrationCardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 16,
  },

  integrationTitle: {
    fontSize: 16,
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: -0.2,
  },

  integrationSlug: {
    fontSize: 12,
    color: "#777",
    marginTop: 4,
  },

  statusTag: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },

  integrationMetaRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginTop: "auto",
  },

  miniMetric: {
    border: "1px solid #f0f0f0",
    background: "#fafafa",
    borderRadius: 10,
    padding: 10,
  },

  miniMetricLabel: {
    fontSize: 11,
    color: "#888",
    marginBottom: 6,
  },

  miniMetricValue: {
    fontSize: 12,
    color: "#222",
    fontWeight: 500,
    wordBreak: "break-word",
  },

  integrationFooter: {
    marginTop: 14,
    paddingTop: 14,
    borderTop: "1px solid #f1f1f1",
    display: "flex",
    justifyContent: "flex-end",
  },

  integrationAction: {
    textDecoration: "none",
    fontSize: 12,
    color: "#111",
    fontWeight: 500,
  },

  listCard: {
    border: "1px solid #eaeaea",
    borderRadius: 14,
    background: "#fff",
    overflow: "hidden",
  },

  listHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    padding: 16,
    borderBottom: "1px solid #efefef",
    flexWrap: "wrap",
  },

  listTitle: {
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.2,
  },

  listSubtitle: {
    fontSize: 12,
    color: "#777",
    marginTop: 4,
  },

  inlineSummary: {
    cursor: "pointer",
    fontSize: 12,
    color: "#444",
  },

  compactConnectForm: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    flexWrap: "wrap",
  },

  inlineInput: {
    height: 34,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 13,
    minWidth: 160,
    background: "#fff",
  },

  tableWrap: {
    width: "100%",
    overflowX: "auto",
  },

  table: {
    width: "100%",
    borderCollapse: "collapse",
  },

  th: {
    textAlign: "left",
    fontSize: 12,
    fontWeight: 500,
    color: "#777",
    padding: "12px 16px",
    borderBottom: "1px solid #efefef",
    whiteSpace: "nowrap",
  },

  td: {
    fontSize: 13,
    color: "#444",
    padding: "14px 16px",
    borderBottom: "1px solid #f3f3f3",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
  },

  tdStrong: {
    fontSize: 13,
    color: "#111",
    padding: "14px 16px",
    borderBottom: "1px solid #f3f3f3",
    verticalAlign: "middle",
    fontWeight: 500,
    whiteSpace: "nowrap",
  },

  tableLink: {
    color: "#111",
    textDecoration: "none",
    fontWeight: 500,
    fontSize: 13,
  },

  footnote: {
    fontSize: 12,
    color: "#777",
    padding: "0 16px 16px 16px",
    margin: 0,
    lineHeight: 1.5,
  },

  overviewGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 14,
    padding: 16,
  },

  infoPanel: {
    border: "1px solid #efefef",
    borderRadius: 12,
    padding: 14,
    background: "#fafafa",
  },

  infoPanelTitle: {
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 10,
  },

  cleanList: {
    margin: 0,
    paddingLeft: 18,
    color: "#444",
    fontSize: 13,
    lineHeight: 1.7,
  },

  sectionTitle: {
    fontSize: 15,
    fontWeight: 600,
    marginBottom: 10,
  },

  formGrid: {
    display: "grid",
    gap: 14,
  },

  panel: {
    border: "1px solid #eaeaea",
    borderRadius: 14,
    background: "#fff",
    padding: 16,
  },

  mutedText: {
    fontSize: 13,
    color: "#555",
    lineHeight: 1.6,
    margin: 0,
  },

  calloutOk: {
    marginTop: 12,
    border: "1px solid rgba(0,112,243,0.15)",
    background: "rgba(0,112,243,0.05)",
    color: "#0059c9",
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    lineHeight: 1.5,
  },

  calloutWarn: {
    marginTop: 12,
    border: "1px solid rgba(217,119,6,0.18)",
    background: "rgba(245,158,11,0.08)",
    color: "#92400e",
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    lineHeight: 1.5,
  },

  buttonRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 14,
  },

  formStack: {
    display: "grid",
    gap: 12,
    maxWidth: 560,
    marginTop: 12,
  },

  label: {
    display: "grid",
    gap: 6,
    fontSize: 12,
    color: "#555",
  },

  labelCompact: {
    display: "grid",
    gap: 6,
    fontSize: 12,
    color: "#555",
  },

  input: {
    width: "100%",
    height: 38,
    border: "1px solid #e5e5e5",
    borderRadius: 10,
    padding: "0 12px",
    fontSize: 13,
    background: "#fff",
    color: "#111",
    outline: "none",
  },

  inputSmall: {
    width: 220,
    height: 38,
    border: "1px solid #e5e5e5",
    borderRadius: 10,
    padding: "0 12px",
    fontSize: 13,
    background: "#fff",
    color: "#111",
    outline: "none",
  },

  intervalForm: {
    display: "flex",
    gap: 10,
    alignItems: "flex-end",
    flexWrap: "wrap",
  },

  inlineLink: {
    color: "#111",
    textDecoration: "none",
  },
};
