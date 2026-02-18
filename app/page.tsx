export default function Home() {
  return (
    <main>
      <h1>ZeroClaw/OpenClaw → Vercel Workflow Gateway</h1>
      <p>
        This deployment exposes bot endpoints at <code>/telegram</code>, <code>/whatsapp</code>,{" "}
        <code>/sms</code>, plus internal APIs at <code>/webhook</code> and pairing at <code>/pair</code>.
      </p>
      <ul>
        <li><a href="/health">/health</a></li>
              <li><a href="/ui">/ui (admin)</a></li>
      </ul>
    </main>
  );
}
