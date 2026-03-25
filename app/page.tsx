"use client"

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "40px 20px",
        maxWidth: "1100px",
        margin: "0 auto",
        color: "#fff",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        background: "radial-gradient(circle at top, #111 0%, #000 100%)",
      }}
    >
      <div
        style={{
          display: "inline-block",
          padding: "6px 12px",
          borderRadius: "999px",
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.1)",
          fontSize: "13px",
          marginBottom: "20px",
        }}
      >
        Serverless ZeroClaw / OpenClaw
      </div>

      <div
        style={{
          display: "grid",
          gap: "40px",
          gridTemplateColumns: "1.3fr 0.7fr",
          alignItems: "center",
        }}
      >
        <section>
          <h1
            style={{
              fontSize: "48px",
              marginBottom: "16px",
              letterSpacing: "-1px",
            }}
          >
            Admin Dashboard
          </h1>

          <p
            style={{
              color: "#bbb",
              lineHeight: 1.6,
              fontSize: "16px",
            }}
          >
            This deployment exposes bot endpoints at <code style={codeStyle}>/telegram</code>,{" "}
            <code style={codeStyle}>/whatsapp</code>, <code style={codeStyle}>/sms</code>, plus
            internal APIs at <code style={codeStyle}>/webhook</code> and pairing at{" "}
            <code style={codeStyle}>/pair</code>.
          </p>

          <div
            style={{
              marginTop: "24px",
              display: "flex",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <a href="/ui" style={{ ...btnStyle, ...primaryBtnStyle }}>
              Open Admin UI
            </a>
            <a href="/health" style={{ ...btnStyle, ...secondaryBtnStyle }}>
              Check Health
            </a>
          </div>
        </section>

        <aside
          style={{
            padding: "20px",
            borderRadius: "20px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            backdropFilter: "blur(10px)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
            }}
          >
            <h2 style={{ margin: 0 }}>Quick Access</h2>
            <span
              style={{
                background: "rgba(0,255,150,0.15)",
                color: "#4ade80",
                padding: "4px 10px",
                borderRadius: "999px",
                fontSize: "12px",
              }}
            >
              Online
            </span>
          </div>

          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
            }}
          >
            <li style={{ marginBottom: "10px" }}>
              <a href="/health" style={linkStyle}>
                /health →
              </a>
            </li>
            <li style={{ marginBottom: "10px" }}>
              <a href="/ui" style={linkStyle}>
                /ui (admin) →
              </a>
            </li>
          </ul>

          <div style={{ marginTop: "20px" }}>
            <p
              style={{
                fontSize: "13px",
                color: "#888",
                marginBottom: "8px",
              }}
            >
              Available routes
            </p>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
              }}
            >
              {["/telegram", "/whatsapp", "/sms", "/webhook", "/pair"].map((route) => (
                <span
                  key={route}
                  style={{
                    background: "rgba(255,255,255,0.1)",
                    padding: "6px 10px",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                >
                  {route}
                </span>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

const codeStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  padding: "2px 6px",
  borderRadius: "6px",
  color: "#fff",
};

const btnStyle: React.CSSProperties = {
  padding: "12px 18px",
  borderRadius: "12px",
  textDecoration: "none",
  fontSize: "14px",
  display: "inline-block",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "#fff",
  color: "#000",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#fff",
};

const linkStyle: React.CSSProperties = {
  display: "block",
  padding: "10px 14px",
  borderRadius: "12px",
  textDecoration: "none",
  color: "#ccc",
  background: "rgba(0,0,0,0.3)",
  border: "1px solid rgba(255,255,255,0.05)",
};
