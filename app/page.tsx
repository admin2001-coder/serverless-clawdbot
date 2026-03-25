export default function Home() {
  return (
    <>
      <main className="container">
        <div className="badge">Serverless ZeroClaw / OpenClaw</div>

        <div className="grid">
          <section>
            <h1>Admin Dashboard</h1>

            <p>
              This deployment exposes bot endpoints at{" "}
              <code>/telegram</code>, <code>/whatsapp</code>, <code>/sms</code>, plus internal APIs at{" "}
              <code>/webhook</code> and pairing at <code>/pair</code>.
            </p>

            <div className="actions">
              <a href="/ui" className="btn primary">Open Admin UI</a>
              <a href="/health" className="btn secondary">Check Health</a>
            </div>
          </section>

          <aside className="card">
            <div className="card-header">
              <h2>Quick Access</h2>
              <span className="status">Online</span>
            </div>

            <ul className="links">
              <li><a href="/health">/health →</a></li>
              <li><a href="/ui">/ui (admin) →</a></li>
            </ul>

            <div className="routes">
              <p>Available routes</p>
              <div className="chips">
                <span>/telegram</span>
                <span>/whatsapp</span>
                <span>/sms</span>
                <span>/webhook</span>
                <span>/pair</span>
              </div>
            </div>
          </aside>
        </div>
      </main>

      <style jsx>{`
        .container {
          min-height: 100vh;
          padding: 40px 20px;
          max-width: 1100px;
          margin: 0 auto;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: radial-gradient(circle at top, #111 0%, #000 100%);
        }

        .badge {
          display: inline-block;
          padding: 6px 12px;
          border-radius: 999px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          font-size: 13px;
          margin-bottom: 20px;
        }

        .grid {
          display: grid;
          gap: 40px;
        }

        @media (min-width: 900px) {
          .grid {
            grid-template-columns: 1.3fr 0.7fr;
            align-items: center;
          }
        }

        h1 {
          font-size: 48px;
          margin-bottom: 16px;
          letter-spacing: -1px;
        }

        p {
          color: #bbb;
          line-height: 1.6;
          font-size: 16px;
        }

        code {
          background: rgba(255,255,255,0.1);
          padding: 2px 6px;
          border-radius: 6px;
          color: #fff;
        }

        .actions {
          margin-top: 24px;
          display: flex;
          gap: 12px;
        }

        .btn {
          padding: 12px 18px;
          border-radius: 12px;
          text-decoration: none;
          font-size: 14px;
          transition: all 0.2s ease;
          display: inline-block;
        }

        .btn.primary {
          background: #fff;
          color: #000;
        }

        .btn.primary:hover {
          transform: translateY(-2px);
          background: #ddd;
        }

        .btn.secondary {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          color: #fff;
        }

        .btn.secondary:hover {
          background: rgba(255,255,255,0.1);
          transform: translateY(-2px);
        }

        .card {
          padding: 20px;
          border-radius: 20px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(10px);
        }

        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .status {
          background: rgba(0,255,150,0.15);
          color: #4ade80;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 12px;
        }

        .links {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .links li {
          margin-bottom: 10px;
        }

        .links a {
          display: block;
          padding: 10px 14px;
          border-radius: 12px;
          text-decoration: none;
          color: #ccc;
          background: rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.05);
          transition: all 0.2s ease;
        }

        .links a:hover {
          background: rgba(255,255,255,0.1);
          color: #fff;
        }

        .routes {
          margin-top: 20px;
        }

        .routes p {
          font-size: 13px;
          color: #888;
          margin-bottom: 8px;
        }

        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .chips span {
          background: rgba(255,255,255,0.1);
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
        }
      `}</style>
    </>
  );
}
