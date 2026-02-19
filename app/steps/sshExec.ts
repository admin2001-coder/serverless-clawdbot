import { env, csvEnv } from "@/app/lib/env";

export async function sshExec(command: string) {
  "use step";

  const host = env("SSH_HOST");
  const user = env("SSH_USER");
  const port = Number(env("SSH_PORT") ?? "22");
  const keyB64 = env("SSH_PRIVATE_KEY_B64");

  if (!host || !user || !keyB64) {
    throw new Error("SSH not configured (SSH_HOST/SSH_USER/SSH_PRIVATE_KEY_B64).");
  }

  const allowedPrefixes = csvEnv("SSH_ALLOWED_PREFIXES");
  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((p) => command.startsWith(p))) {
    throw new Error(`SSH command not allowed by policy. Allowed prefixes: ${allowedPrefixes.join(", ")}`);
  }

  // ✅ Dynamic import so Turbopack doesn't bundle ssh2
  const mod: any = await import("ssh2");
  const Client = mod.Client ?? mod.default?.Client ?? mod.default ?? mod;

  const privateKey = Buffer.from(keyB64, "base64").toString("utf8");

  return await new Promise<string>((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err: any, stream: any) => {
          if (err) return reject(err);
          let out = "";
          let errOut = "";
          stream.on("data", (d: any) => (out += d.toString("utf8")));
          stream.stderr.on("data", (d: any) => (errOut += d.toString("utf8")));
          stream.on("close", (code: any) => {
            conn.end();
            if (code && code !== 0) return reject(new Error(`SSH exit code ${code}: ${errOut || out}`));
            resolve(out || errOut);
          });
        });
      })
      .on("error", reject)
      .connect({ host, port, username: user, privateKey });
  });
}
