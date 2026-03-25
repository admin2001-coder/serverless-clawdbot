// page.tsx
import type { CSSProperties } from "react";
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

type SearchParams = {
  userId?: string;
  tab?: string;
  q?: string;
};

type TabKey =
  | "overview"
  | "projects"
  | "integrations"
  | "activity"
  | "domains"
  | "usage"
  | "settings";

type ToolkitItem = {
  slug: string;
  name?: string;
  connected: boolean;
  connectedAccountId?: string;
};

async function baseUrlFromHeaders(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

function formatToolkitName(slug: string, name?: string) {
  if (name && name.trim()) return name;
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function firstLetter(value: string) {
  const clean = value.trim();
  return clean ? clean[0]!.toUpperCase() : "D";
}

function initialsFromSlug(slug: string) {
  const parts = slug.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function navHref(tab: TabKey, userId: string, q?: string) {
  const params = new URLSearchParams();
  params.set("tab", tab);
  params.set("userId", userId);
  if (q) params.set("q", q);
  return `/ui?${params.toString()}`;
}

function toolkitLogo(slug: string): string | null {
  const key = slug.toLowerCase();

  const explicit: Record<string, string> = {
    gmail: "https://cdn.simpleicons.org/gmail",
    googlecalendar: "https://cdn.simpleicons.org/googlecalendar",
    google_calendar: "https://cdn.simpleicons.org/googlecalendar",
    googledrive: "https://cdn.simpleicons.org/googledrive",
    google_drive: "https://cdn.simpleicons.org/googledrive",
    googlecontacts: "https://cdn.simpleicons.org/googlecontacts",
    google_contacts: "https://cdn.simpleicons.org/googlecontacts",
    github: "https://cdn.simpleicons.org/github",
    gitlab: "https://cdn.simpleicons.org/gitlab",
    slack: "https://cdn.simpleicons.org/slack",
    notion: "https://cdn.simpleicons.org/notion",
    discord: "https://cdn.simpleicons.org/discord",
    linear: "https://cdn.simpleicons.org/linear",
    jira: "https://cdn.simpleicons.org/jira",
    atlassian: "https://cdn.simpleicons.org/atlassian",
    trello: "https://cdn.simpleicons.org/trello",
    asana: "https://cdn.simpleicons.org/asana",
    hubspot: "https://cdn.simpleicons.org/hubspot",
    salesforce: "https://cdn.simpleicons.org/salesforce",
    shopify: "https://cdn.simpleicons.org/shopify",
    stripe: "https://cdn.simpleicons.org/stripe",
    zoom: "https://cdn.simpleicons.org/zoom",
    dropbox: "https://cdn.simpleicons.org/dropbox",
    box: "https://cdn.simpleicons.org/box",
    airtable: "https://cdn.simpleicons.org/airtable",
    clickup: "https://cdn.simpleicons.org/clickup",
    figma: "https://cdn.simpleicons.org/figma",
    calendly: "https://cdn.simpleicons.org/calendly",
    resend: "https://cdn.simpleicons.org/resend",
    twilio: "https://cdn.simpleicons.org/twilio",
    whatsapp: "https://cdn.simpleicons.org/whatsapp",
    telegram: "https://cdn.simpleicons.org/telegram",
    zendesk: "https://cdn.simpleicons.org/zendesk",
    intercom: "https://cdn.simpleicons.org/intercom",
    postgres: "https://cdn.simpleicons.org/postgresql",
    postgresql: "https://cdn.simpleicons.org/postgresql",
    mysql: "https://cdn.simpleicons.org/mysql",
    mongodb: "https://cdn.simpleicons.org/mongodb",
    redis: "https://cdn.simpleicons.org/redis",
    vercel: "https://cdn.simpleicons.org/vercel",
    openai: "https://cdn.simpleicons.org/openai",
    anthropic: "https://cdn.simpleicons.org/anthropic",
    x: "https://cdn.simpleicons.org/x",
    twitter: "https://cdn.simpleicons.org/x",
    linkedin: "https://cdn.simpleicons.org/linkedin",
    microsoftoutlook: "https://cdn.simpleicons.org/microsoftoutlook",
    microsoft_outlook: "https://cdn.simpleicons.org/microsoftoutlook",
    outlook: "https://cdn.simpleicons.org/microsoftoutlook",
    teams: "https://cdn.simpleicons.org/microsoftteams",
    microsoftteams: "https://cdn.simpleicons.org/microsoftteams",
    microsoft_teams: "https://cdn.simpleicons.org/microsoftteams",
    onedrive: "https://cdn.simpleicons.org/microsoftonedrive",
    microsoft_onedrive: "https://cdn.simpleicons.org/microsoftonedrive",
    sharepoint: "https://cdn.simpleicons.org/microsoftsharepoint",
    microsoft_sharepoint: "https://cdn.simpleicons.org/microsoftsharepoint",
  };

  if (explicit[key]) return explicit[key]!;

  const normalized = key.replace(/[^a-z0-9]/g, "");
  if (explicit[normalized]) return explicit[normalized]!;

  return null;
}

function humanTimeAgo(index: number) {
  const values = ["4m", "9m", "18m", "43m", "1h", "2h", "6h", "1d", "3d"];
  return values[index % values.length]!;
}

function activityLineForToolkit(toolkit: ToolkitItem, index: number) {
  const name = formatToolkitName(toolkit.slug, toolkit.name);
  if (toolkit.connected) {
    return {
      lead: "zeroclaw",
      text: `connected ${name}`,
      sub: toolkit.connectedAccountId
        ? `account ${toolkit.connectedAccountId.slice(0, 8)}`
        : "active integration",
      time: humanTimeAgo(index),
    };
  }

  return {
    lead: "zeroclaw",
    text: `integration pending for ${name}`,
    sub: "authorize to enable toolkit access",
    time: humanTimeAgo(index),
  };
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
      raw === "overview" ||
      raw === "projects" ||
      raw === "integrations" ||
      raw === "activity" ||
      raw === "domains" ||
      raw === "usage" ||
      raw === "settings"
    ) {
      return raw;
    }
    return "overview";
  })();

  const searchQuery = sp.q?.trim().toLowerCase() ?? "";

  const baseUrlRaw = env("APP_BASE_URL") ?? (await baseUrlFromHeaders());
  const normalizedBase = baseUrlRaw.replace(/\/$/, "");

  const gateway = await getGatewayAuthStatus();
  const pairing = gateway.paired ? null : await ensurePairingCode();
  const pairingCode = gateway.paired ? undefined : pairing?.code ?? gateway.pairingCode;

  let composioToolkits: ToolkitItem[] = [];
  let composioError: string | null = null;

  if (env("COMPOSIO_API_KEY")) {
    try {
      const composio = new Composio({ provider: new VercelProvider() });
      const session: any = await composio.create(userId, { manageConnections: false });
      const toolkits: any = await session.toolkits();
      const items = toolkits?.items ?? toolkits?.toolkits ?? [];
      composioToolkits = (items as any[]).map((t) => {
        const slug = t.slug ?? t.name ?? "unknown";
        const connectedAccountId =
          t.connection?.connectedAccount?.id ?? t.connection?.connected_account?.id;
        const connected =
          !!connectedAccountId || !!t.connection?.isActive || !!t.connection?.is_active;
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

  const filteredToolkits = composioToolkits.filter((t) => {
    if (!searchQuery) return true;
    const hay = `${t.slug} ${t.name ?? ""}`.toLowerCase();
    return hay.includes(searchQuery);
  });

  const visibleCards = filteredToolkits.slice(0, 4);
  const activityItems = (filteredToolkits.length ? filteredToolkits : composioToolkits)
    .slice(0, 5)
    .map(activityLineForToolkit);

  const connectedCount = composioToolkits.filter((t) => t.connected).length;
  const userLabel = userId.includes(":") ? userId.split(":")[1] || userId : userId;
  const profileName = userLabel === "admin" ? "Admin" : userLabel;

  const telegramWebhookUrl = `${normalizedBase}/telegram`;
  const whatsappWebhookUrl = `${normalizedBase}/whatsapp`;
  const smsWebhookUrl = `${normalizedBase}/sms`;

  const topTabs: TabKey[] = [
    "overview",
    "projects",
    "integrations",
    "activity",
    "domains",
    "usage",
    "settings",
  ];

  return (
    <main style={styles.page}>
      <div style={styles.app}>
        <header style={styles.topbar}>
          <div style={styles.topbarLeft}>
            <div style={styles.brandMark} aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7.5 4.5c1.7 0 3.1 1 4.5 3.1 1.4-2.1 2.8-3.1 4.5-3.1a3 3 0 0 1 2.9 3c0 1.7-1 3.1-3.1 4.5 2.1 1.4 3.1 2.8 3.1 4.5a3 3 0 0 1-3 3c-1.7 0-3.1-1-4.4-3.1-1.4 2.1-2.8 3.1-4.5 3.1a3 3 0 0 1-3-3c0-1.7 1-3.1 3.1-4.5-2.1-1.4-3.1-2.8-3.1-4.5a3 3 0 0 1 3-3Z"
                  stroke="#111"
                  strokeWidth="1.7"
                />
              </svg>
            </div>
            <div style={styles.slash}>/</div>
            <div style={styles.workspaceName}>{profileName}</div>
          </div>

          <div style={styles.topbarRight}>
            <a href="#feedback" style={styles.feedbackButton}>
              Feedback
            </a>
            <Link href={navHref("activity", userId, searchQuery)} style={styles.toplink}>
              Changelog
            </Link>
            <Link href={navHref("settings", userId, searchQuery)} style={styles.toplink}>
              Support
            </Link>
            <Link href={navHref("domains", userId, searchQuery)} style={styles.toplink}>
              Docs
            </Link>
            <span style={styles.topDots}>•••</span>
            <div style={styles.avatarCircle}>{firstLetter(profileName)}</div>
          </div>
        </header>

        <div style={styles.tabbar}>
          {topTabs.map((tab) => {
            const label = tab[0]!.toUpperCase() + tab.slice(1);
            const isActive = activeTab === tab;
            return (
              <Link
                key={tab}
                href={navHref(tab, userId, searchQuery)}
                style={isActive ? styles.mainTabActive : styles.mainTab}
              >
                {label}
              </Link>
            );
          })}
        </div>

        <section style={styles.content}>
          <div style={styles.heroRow}>
            <div style={styles.heroLeft}>
              <div style={styles.bigAvatar}>{firstLetter(profileName)}</div>
              <div>
                <h1 style={styles.pageTitle}>{profileName}&apos;s Integrations</h1>
                <div style={styles.subline}>
                  <span style={styles.gitIcon}>⌘</span>
                  <span>
                    Connected to Composio{" "}
                    <span style={styles.slashInline}>/</span>{" "}
                    <Link href={navHref("settings", userId, searchQuery)} style={styles.inlineBlue}>
                      Settings
                    </Link>
                  </span>
                </div>
              </div>
            </div>

            <div>
              <details>
                <summary style={styles.primaryAction}>New Project ▾</summary>
                <div style={styles.menuPopover}>
                  <Link href={navHref("integrations", userId, searchQuery)} style={styles.menuItem}>
                    View integrations
                  </Link>
                  <Link href={navHref("settings", userId, searchQuery)} style={styles.menuItem}>
                    Open settings
                  </Link>
                </div>
              </details>
            </div>
          </div>

          <div style={styles.searchRow}>
            <form method="get" action="/ui" style={styles.searchForm}>
              <input type="hidden" name="tab" value={activeTab} />
              <input type="hidden" name="userId" value={userId} />
              <div style={styles.searchWrap}>
                <span style={styles.searchIcon}>⌕</span>
                <input
                  name="q"
                  defaultValue={sp.q ?? ""}
                  placeholder="Search..."
                  style={styles.searchInput}
                />
              </div>
              <button type="submit" style={styles.newProjectButton}>
                New Project
              </button>
              <Link href={navHref("settings", userId, searchQuery)} style={styles.iconButton}>
                ⍟
              </Link>
            </form>
          </div>

          {activeTab === "overview" && (
            <div style={styles.mainGrid}>
              <div style={styles.cardsArea}>
                {composioError ? (
                  <div style={styles.errorCard}>{composioError}</div>
                ) : visibleCards.length === 0 ? (
                  <div style={styles.errorCard}>No integrations matched your search.</div>
                ) : (
                  visibleCards.map((toolkit, index) => {
                    const logo = toolkitLogo(toolkit.slug);
                    const displayName = formatToolkitName(toolkit.slug, toolkit.name);
                    return (
                      <article key={toolkit.slug} style={styles.projectCard}>
                        <div style={styles.cardHead}>
                          <div style={styles.cardIdentity}>
                            <div style={styles.logoBadge}>
                              {logo ? (
                                <img
                                  src={logo}
                                  alt={displayName}
                                  style={styles.logoImage}
                                />
                              ) : (
                                <span style={styles.logoFallback}>{initialsFromSlug(toolkit.slug)}</span>
                              )}
                            </div>

                            <div>
                              <div style={styles.cardTitleRow}>
                                <div style={styles.cardTitle}>{displayName}</div>
                                {toolkit.connected ? (
                                  <span style={styles.healthPill}>100</span>
                                ) : (
                                  <span style={styles.healthPillMuted}>—</span>
                                )}
                              </div>
                              <div style={styles.cardDomain}>
                                {toolkit.connected
                                  ? `${toolkit.slug}.connected`
                                  : `${toolkit.slug}.not-connected`}
                              </div>
                            </div>
                          </div>
                        </div>

                        <p style={styles.cardDescription}>
                          {toolkit.connected
                            ? `${displayName} is authorized and ready for agent use through Composio.`
                            : `${displayName} is available but still needs authorization before the agent can use it.`}
                        </p>

                        <div style={styles.cardFooter}>
                          {toolkit.connected
                            ? `${humanTimeAgo(index)} ago via Composio`
                            : `pending via Composio`}
                        </div>
                      </article>
                    );
                  })
                )}
              </div>

              <aside style={styles.activityPanel}>
                <h2 style={styles.activityTitle}>Recent Activity</h2>

                {composioError ? (
                  <p style={styles.activityEmpty}>Composio is unavailable.</p>
                ) : (
                  <div style={styles.activityList}>
                    {activityItems.map((item, idx) => (
                      <div key={`${item.text}-${idx}`} style={styles.activityItem}>
                        <div style={styles.activityIconWrap}>
                          <div style={styles.activityIcon}>▲</div>
                        </div>
                        <div style={styles.activityBody}>
                          <div style={styles.activityText}>
                            <strong>{item.lead}</strong> {item.text}
                          </div>
                          <div style={styles.activitySub}>{item.sub}</div>
                        </div>
                        <div style={styles.activityTime}>{item.time}</div>
                      </div>
                    ))}
                  </div>
                )}
              </aside>
            </div>
          )}

          {activeTab === "projects" && (
            <section style={styles.panelCard}>
              <h2 style={styles.sectionTitle}>Projects</h2>
              <p style={styles.sectionText}>
                The main overview already presents integrations in the project-card layout. Use the
                Overview tab as the primary dashboard surface.
              </p>
            </section>
          )}

          {activeTab === "integrations" && (
            <section style={styles.panelCard}>
              <h2 style={styles.sectionTitle}>All Integrations</h2>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Integration</th>
                      <th style={styles.th}>Slug</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>Account</th>
                      <th style={styles.th}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {composioError ? (
                      <tr>
                        <td colSpan={5} style={styles.td}>
                          {composioError}
                        </td>
                      </tr>
                    ) : (
                      filteredToolkits.map((t) => {
                        const logo = toolkitLogo(t.slug);
                        const name = formatToolkitName(t.slug, t.name);
                        return (
                          <tr key={t.slug}>
                            <td style={styles.tdStrong}>
                              <div style={styles.integrationCell}>
                                <div style={styles.smallLogoBadge}>
                                  {logo ? (
                                    <img src={logo} alt={name} style={styles.smallLogoImage} />
                                  ) : (
                                    <span style={styles.smallLogoFallback}>{initialsFromSlug(t.slug)}</span>
                                  )}
                                </div>
                                <span>{name}</span>
                              </div>
                            </td>
                            <td style={styles.td}>
                              <code>{t.slug}</code>
                            </td>
                            <td style={styles.td}>{t.connected ? "Connected" : "Pending"}</td>
                            <td style={styles.td}>
                              {t.connectedAccountId ? <code>{t.connectedAccountId}</code> : "—"}
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
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === "activity" && (
            <section style={styles.panelCard}>
              <h2 style={styles.sectionTitle}>Activity</h2>
              <div style={styles.activityListLarge}>
                {activityItems.map((item, idx) => (
                  <div key={`${item.text}-large-${idx}`} style={styles.activityItemLarge}>
                    <div style={styles.activityIconWrap}>
                      <div style={styles.activityIcon}>▲</div>
                    </div>
                    <div style={styles.activityBodyLarge}>
                      <div style={styles.activityText}>
                        <strong>{item.lead}</strong> {item.text}
                      </div>
                      <div style={styles.activitySub}>{item.sub}</div>
                    </div>
                    <div style={styles.activityTime}>{item.time}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {activeTab === "domains" && (
            <section style={styles.panelCard}>
              <h2 style={styles.sectionTitle}>Endpoints</h2>
              <ul style={styles.infoList}>
                <li>
                  <code>{normalizedBase}/health</code>
                </li>
                <li>
                  <code>{telegramWebhookUrl}</code>
                </li>
                <li>
                  <code>{whatsappWebhookUrl}</code>
                </li>
                <li>
                  <code>{smsWebhookUrl}</code>
                </li>
                <li>
                  <code>{normalizedBase}/pair</code>
                </li>
                <li>
                  <code>{normalizedBase}/webhook</code>
                </li>
              </ul>
            </section>
          )}

          {activeTab === "usage" && (
            <section style={styles.panelCard}>
              <h2 style={styles.sectionTitle}>Usage</h2>
              <div style={styles.usageGrid}>
                <div style={styles.metricCard}>
                  <div style={styles.metricLabel}>Connected Integrations</div>
                  <div style={styles.metricValue}>{connectedCount}</div>
                </div>
                <div style={styles.metricCard}>
                  <div style={styles.metricLabel}>Available Toolkits</div>
                  <div style={styles.metricValue}>{composioToolkits.length}</div>
                </div>
                <div style={styles.metricCard}>
                  <div style={styles.metricLabel}>Autopilot</div>
                  <div style={styles.metricValueSmall}>
                    {autopilotEnabled ? "Enabled" : "Disabled"}
                  </div>
                </div>
                <div style={styles.metricCard}>
                  <div style={styles.metricLabel}>Interval</div>
                  <div style={styles.metricValueSmall}>{intervalSeconds}s</div>
                </div>
              </div>
            </section>
          )}

          {activeTab === "settings" && (
            <section style={styles.settingsGrid}>
              <div style={styles.panelCard}>
                <h2 style={styles.sectionTitle}>Identity</h2>
                <form method="get" action="/ui" style={styles.formStack}>
                  <input type="hidden" name="tab" value="overview" />
                  <label style={styles.label}>
                    <span>Composio userId</span>
                    <input
                      name="userId"
                      defaultValue={userId}
                      placeholder="telegram:123456789"
                      style={styles.input}
                    />
                  </label>
                  <button type="submit" style={styles.submitButton}>
                    Load
                  </button>
                </form>
              </div>

              <div style={styles.panelCard}>
                <h2 style={styles.sectionTitle}>Gateway</h2>
                <p style={styles.sectionText}>
                  Pair URL: <code>{normalizedBase}/pair</code>
                  <br />
                  Webhook URL: <code>{normalizedBase}/webhook</code>
                </p>
                <p style={styles.sectionText}>
                  {gateway.paired ? (
                    <>Gateway is paired.</>
                  ) : (
                    <>
                      Gateway is not paired.
                      <br />
                      Pairing code: <code>{pairingCode ?? "(not generated yet)"}</code>
                    </>
                  )}
                </p>
                <div style={styles.actionRow}>
                  <form action="/api/ui/gateway/regenerate-pairing" method="post">
                    <button type="submit" style={styles.submitButtonAlt}>
                      Regenerate pairing code
                    </button>
                  </form>
                  <form action="/api/ui/gateway/clear-token" method="post">
                    <button type="submit" style={styles.submitButton}>
                      Clear bearer token
                    </button>
                  </form>
                </div>
              </div>

              <div style={styles.panelCard}>
                <h2 style={styles.sectionTitle}>Channels</h2>
                <div style={styles.actionRow}>
                  <form action="/api/ui/telegram/set-webhook" method="post">
                    <button type="submit" style={styles.submitButton}>
                      Set Telegram webhook
                    </button>
                  </form>
                  <form action="/api/ui/telegram/delete-webhook" method="post">
                    <button type="submit" style={styles.submitButtonAlt}>
                      Delete Telegram webhook
                    </button>
                  </form>
                </div>
                <div style={{ ...styles.actionRow, marginTop: 10 }}>
                  <form action="/api/ui/autopilot/start" method="post">
                    <button type="submit" style={styles.submitButton}>
                      Start Autopilot
                    </button>
                  </form>
                  <form action="/api/ui/autopilot/stop" method="post">
                    <button type="submit" style={styles.submitButtonAlt}>
                      Stop Autopilot
                    </button>
                  </form>
                </div>
                <p style={{ ...styles.sectionText, marginTop: 14 }}>
                  Primary destination:{" "}
                  <code>{primary ? `${primary.channel} / ${primary.sessionId}` : "(not set yet)"}</code>
                </p>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f6f6f6",
    padding: 0,
    margin: 0,
    color: "#111",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  },

  app: {
    minHeight: "100vh",
    background: "#fff",
    borderLeft: "4px solid #0a63b0",
  },

  topbar: {
    height: 82,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 30px 0 124px",
    borderBottom: "1px solid #e6e6e6",
    gap: 16,
    flexWrap: "wrap",
  },

  topbarLeft: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },

  brandMark: {
    width: 24,
    height: 24,
    display: "grid",
    placeItems: "center",
  },

  slash: {
    color: "#777",
    fontSize: 40,
    lineHeight: 1,
    fontWeight: 200,
    marginTop: -4,
  },

  workspaceName: {
    fontSize: 33,
    fontWeight: 500,
    lineHeight: 1,
    letterSpacing: "-0.02em",
  },

  topbarRight: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    marginLeft: "auto",
  },

  feedbackButton: {
    textDecoration: "none",
    color: "#111",
    border: "1px solid #d7d7d7",
    borderRadius: 12,
    padding: "12px 18px",
    fontSize: 14,
    fontWeight: 500,
    background: "#fff",
  },

  toplink: {
    textDecoration: "none",
    color: "#111",
    fontSize: 14,
    fontWeight: 500,
  },

  topDots: {
    color: "#111",
    fontSize: 18,
    lineHeight: 1,
    letterSpacing: 1,
  },

  avatarCircle: {
    width: 38,
    height: 38,
    borderRadius: 999,
    background: "#005fa9",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontSize: 20,
    fontWeight: 500,
  },

  tabbar: {
    height: 72,
    display: "flex",
    alignItems: "flex-end",
    gap: 28,
    padding: "0 30px 0 124px",
    borderBottom: "1px solid #e6e6e6",
    overflowX: "auto",
  },

  mainTab: {
    textDecoration: "none",
    color: "#666",
    fontSize: 16,
    fontWeight: 500,
    paddingBottom: 18,
    borderBottom: "3px solid transparent",
    whiteSpace: "nowrap",
  },

  mainTabActive: {
    textDecoration: "none",
    color: "#111",
    fontSize: 16,
    fontWeight: 600,
    paddingBottom: 18,
    borderBottom: "3px solid #111",
    whiteSpace: "nowrap",
  },

  content: {
    padding: "38px 152px 60px 152px",
  },

  heroRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
    marginBottom: 34,
    flexWrap: "wrap",
  },

  heroLeft: {
    display: "flex",
    alignItems: "center",
    gap: 20,
  },

  bigAvatar: {
    width: 76,
    height: 76,
    borderRadius: 999,
    background: "#005fa9",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontSize: 48,
    fontWeight: 400,
  },

  pageTitle: {
    margin: 0,
    fontSize: 30,
    lineHeight: 1.15,
    letterSpacing: "-0.03em",
    fontWeight: 650,
  },

  subline: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
    color: "#6a6a6a",
    fontSize: 15,
  },

  gitIcon: {
    fontSize: 16,
    opacity: 0.8,
  },

  slashInline: {
    color: "#b4b4b4",
    margin: "0 4px",
  },

  inlineBlue: {
    color: "#2563eb",
    textDecoration: "none",
    fontWeight: 500,
  },

  primaryAction: {
    listStyle: "none",
    cursor: "pointer",
    background: "#111",
    color: "#fff",
    borderRadius: 12,
    padding: "16px 18px",
    fontSize: 14,
    fontWeight: 600,
    minWidth: 160,
    textAlign: "center",
    userSelect: "none",
  },

  menuPopover: {
    position: "absolute",
    marginTop: 8,
    minWidth: 180,
    background: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 12,
    boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
    overflow: "hidden",
    zIndex: 20,
  },

  menuItem: {
    display: "block",
    padding: "12px 14px",
    textDecoration: "none",
    color: "#111",
    fontSize: 14,
  },

  searchRow: {
    marginBottom: 28,
  },

  searchForm: {
    display: "grid",
    gridTemplateColumns: "1fr 150px 58px",
    gap: 18,
    alignItems: "center",
  },

  searchWrap: {
    display: "flex",
    alignItems: "center",
    border: "1px solid #dddddd",
    borderRadius: 14,
    height: 58,
    padding: "0 16px",
    background: "#fff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },

  searchIcon: {
    color: "#8b8b8b",
    marginRight: 10,
    fontSize: 22,
    lineHeight: 1,
  },

  searchInput: {
    width: "100%",
    height: "100%",
    border: 0,
    outline: "none",
    fontSize: 17,
    color: "#111",
    background: "transparent",
  },

  newProjectButton: {
    height: 58,
    border: 0,
    borderRadius: 14,
    background: "#111",
    color: "#fff",
    fontSize: 16,
    fontWeight: 500,
    cursor: "pointer",
  },

  iconButton: {
    height: 58,
    borderRadius: 14,
    border: "1px solid #dddddd",
    display: "grid",
    placeItems: "center",
    textDecoration: "none",
    color: "#111",
    fontSize: 22,
    background: "#fff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },

  mainGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 376px",
    gap: 34,
    alignItems: "start",
  },

  cardsArea: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 20,
  },

  projectCard: {
    minHeight: 260,
    borderRadius: 18,
    border: "1px solid #dddddd",
    background: "#fff",
    boxShadow: "0 2px 6px rgba(0,0,0,0.04)",
    padding: "32px 26px 26px 26px",
    display: "flex",
    flexDirection: "column",
  },

  cardHead: {
    marginBottom: 22,
  },

  cardIdentity: {
    display: "flex",
    alignItems: "center",
    gap: 18,
  },

  logoBadge: {
    width: 44,
    height: 44,
    borderRadius: 999,
    background: "#fff",
    border: "1px solid #e8e8e8",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    flexShrink: 0,
  },

  logoImage: {
    width: 24,
    height: 24,
    objectFit: "contain",
    display: "block",
  },

  logoFallback: {
    fontSize: 12,
    fontWeight: 700,
    color: "#111",
    letterSpacing: "0.04em",
  },

  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 2,
    flexWrap: "wrap",
  },

  cardTitle: {
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1.15,
    color: "#111",
  },

  healthPill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 36,
    height: 30,
    padding: "0 8px",
    borderRadius: 999,
    border: "3px solid #10b94d",
    color: "#10b94d",
    fontWeight: 700,
    fontSize: 14,
    lineHeight: 1,
  },

  healthPillMuted: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 36,
    height: 30,
    padding: "0 8px",
    borderRadius: 999,
    border: "3px solid #cfcfcf",
    color: "#8a8a8a",
    fontWeight: 700,
    fontSize: 14,
    lineHeight: 1,
  },

  cardDomain: {
    fontSize: 14,
    color: "#6d6d6d",
    lineHeight: 1.2,
  },

  cardDescription: {
    margin: "8px 0 0 0",
    color: "#606060",
    fontSize: 17,
    lineHeight: 1.4,
    maxWidth: 500,
  },

  cardFooter: {
    marginTop: "auto",
    paddingTop: 18,
    color: "#6d6d6d",
    fontSize: 14,
  },

  activityPanel: {
    background: "transparent",
  },

  activityTitle: {
    margin: "0 0 18px 0",
    fontSize: 22,
    lineHeight: 1.2,
    fontWeight: 700,
    color: "#111",
  },

  activityList: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },

  activityItem: {
    display: "grid",
    gridTemplateColumns: "50px 1fr auto",
    gap: 12,
    alignItems: "start",
  },

  activityIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 999,
    background: "#fafafa",
    border: "1px solid #e3e3e3",
    display: "grid",
    placeItems: "center",
    boxShadow: "inset 0 0 0 2px #f5f5f5",
  },

  activityIcon: {
    color: "#888",
    fontSize: 14,
    lineHeight: 1,
  },

  activityBody: {
    minWidth: 0,
    paddingTop: 4,
  },

  activityText: {
    color: "#3a3a3a",
    fontSize: 15,
    lineHeight: 1.35,
  },

  activitySub: {
    color: "#7a7a7a",
    fontSize: 14,
    marginTop: 2,
    lineHeight: 1.3,
  },

  activityTime: {
    color: "#787878",
    fontSize: 14,
    whiteSpace: "nowrap",
    paddingTop: 4,
  },

  activityEmpty: {
    color: "#777",
    fontSize: 15,
  },

  panelCard: {
    border: "1px solid #dddddd",
    borderRadius: 18,
    background: "#fff",
    boxShadow: "0 2px 6px rgba(0,0,0,0.04)",
    padding: 24,
  },

  sectionTitle: {
    margin: "0 0 14px 0",
    fontSize: 22,
    fontWeight: 700,
    color: "#111",
  },

  sectionText: {
    margin: 0,
    color: "#555",
    fontSize: 15,
    lineHeight: 1.6,
  },

  tableWrap: {
    overflowX: "auto",
  },

  table: {
    width: "100%",
    borderCollapse: "collapse",
  },

  th: {
    textAlign: "left",
    padding: "12px 12px",
    fontSize: 12,
    color: "#777",
    fontWeight: 600,
    borderBottom: "1px solid #ececec",
    whiteSpace: "nowrap",
  },

  td: {
    padding: "14px 12px",
    fontSize: 14,
    color: "#444",
    borderBottom: "1px solid #f1f1f1",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  },

  tdStrong: {
    padding: "14px 12px",
    fontSize: 14,
    color: "#111",
    borderBottom: "1px solid #f1f1f1",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    fontWeight: 600,
  },

  tableLink: {
    textDecoration: "none",
    color: "#2563eb",
    fontWeight: 600,
  },

  integrationCell: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  smallLogoBadge: {
    width: 28,
    height: 28,
    borderRadius: 999,
    background: "#fff",
    border: "1px solid #ececec",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    flexShrink: 0,
  },

  smallLogoImage: {
    width: 16,
    height: 16,
    objectFit: "contain",
    display: "block",
  },

  smallLogoFallback: {
    fontSize: 10,
    fontWeight: 700,
    color: "#111",
    letterSpacing: "0.04em",
  },

  activityListLarge: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },

  activityItemLarge: {
    display: "grid",
    gridTemplateColumns: "50px 1fr auto",
    gap: 12,
    alignItems: "start",
    paddingBottom: 12,
    borderBottom: "1px solid #f0f0f0",
  },

  activityBodyLarge: {
    minWidth: 0,
  },

  infoList: {
    margin: 0,
    paddingLeft: 18,
    color: "#444",
    fontSize: 15,
    lineHeight: 1.8,
  },

  usageGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 18,
  },

  metricCard: {
    border: "1px solid #e6e6e6",
    borderRadius: 16,
    padding: 20,
    background: "#fff",
  },

  metricLabel: {
    color: "#777",
    fontSize: 13,
    marginBottom: 10,
  },

  metricValue: {
    color: "#111",
    fontSize: 34,
    fontWeight: 700,
    lineHeight: 1,
  },

  metricValueSmall: {
    color: "#111",
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 1.1,
  },

  settingsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 20,
  },

  formStack: {
    display: "grid",
    gap: 12,
  },

  label: {
    display: "grid",
    gap: 6,
    color: "#444",
    fontSize: 13,
  },

  input: {
    width: "100%",
    height: 44,
    borderRadius: 12,
    border: "1px solid #dddddd",
    padding: "0 12px",
    outline: "none",
    fontSize: 15,
    color: "#111",
    background: "#fff",
  },

  submitButton: {
    height: 44,
    borderRadius: 12,
    border: 0,
    background: "#111",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 14px",
  },

  submitButtonAlt: {
    height: 44,
    borderRadius: 12,
    border: "1px solid #dddddd",
    background: "#fff",
    color: "#111",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 14px",
  },

  actionRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },

  errorCard: {
    gridColumn: "1 / -1",
    minHeight: 180,
    borderRadius: 18,
    border: "1px solid #ead0d0",
    background: "#fff7f7",
    color: "#9f1d1d",
    padding: 24,
    fontSize: 15,
    lineHeight: 1.5,
  },
};
