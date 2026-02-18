import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const sp = (await searchParams) ?? {};
  const error = sp.error === "1";

  return (
    <main style={{ maxWidth: 720 }}>
      <h1>Admin UI Login</h1>
      <p>
        This UI is protected by <code>ADMIN_UI_PASSWORD</code>.
      </p>
      {error ? <p style={{ color: "crimson" }}>Invalid password.</p> : null}

      <form action="/api/ui/login" method="post" style={{ display: "grid", gap: 12 }}>
        <label>
          Password
          <input
            type="password"
            name="password"
            placeholder="ADMIN_UI_PASSWORD"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
          />
        </label>
        <button type="submit" style={{ padding: 10 }}>
          Sign in
        </button>
      </form>

      <p style={{ marginTop: 18, fontSize: 14, opacity: 0.8 }}>
        Tip: set <code>ADMIN_UI_PASSWORD</code> in Vercel project environment variables.
      </p>

      <p style={{ marginTop: 18 }}>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
