import Link from "next/link";
import { requireUiAuthPage } from "@/app/lib/uiRequire";

export const dynamic = "force-dynamic";

export default async function ComposioCallbackPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  await requireUiAuthPage();

  const status = String(searchParams?.status ?? "");
  const connectedAccountId = String(searchParams?.connected_account_id ?? "");
  const userId = String(searchParams?.userId ?? "");
  const toolkit = String(searchParams?.toolkit ?? "");

  return (
    <main style={{ maxWidth: 720 }}>
      <h1>Composio Connection Result</h1>

      <p>
        Status: <code>{status || "(missing)"}</code>
      </p>
      <p>
        Toolkit: <code>{toolkit || "(missing)"}</code>
      </p>
      <p>
        User ID: <code>{userId || "(missing)"}</code>
      </p>
      <p>
        Connected account ID: <code>{connectedAccountId || "(missing)"}</code>
      </p>

      <p style={{ marginTop: 20 }}>
        <Link href={`/ui?userId=${encodeURIComponent(userId || "admin")}#composio`}>Back to Integrations</Link>
      </p>
    </main>
  );
}
