import { env, csvEnv } from "@/app/lib/env";

export async function sshExec(command: string): Promise<string> {
  "use step";

  const host = env("SSH_HOST");
  const user = env("SSH_USER");
  const port = Number(env("SSH_PORT") ?? "22");
  const privateKeyB64 = env("SSH_PRIVATE_KEY_B64");

  if (!host || !user) {
    throw new Error("SSH not configured (SSH_HOST/SSH_USER).");
  }

  const allowedPrefixes = csvEnv("SSH_ALLOWED_PREFIXES");
  if (
    allowedPrefixes.length > 0 &&
    !allowedPrefixes.some((p) => command.startsWith(p))
  ) {
    throw new Error(
      `SSH command not allowed by policy. Allowed prefixes: ${allowedPrefixes.join(", ")}`
    );
  }

  if (!privateKeyB64) {
    throw new Error("SSH not configured (SSH_PRIVATE_KEY_B64).");
  }

  const privateKey = Buffer.from(privateKeyB64, "base64").toString("utf8");
  const { Client } = await import("ssh2");

  return await new Promise<string>((resolve, reject) => {
    const conn = new Client();

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          let output = "";

          stream.on("data", (data: Buffer) => {
            output += data.toString();
          });

          stream.stderr.on("data", (data: Buffer) => {
            output += data.toString();
          });

          stream.on("close", () => {
            conn.end();
            resolve(output);
          });
        });
      })
      .on("error", (err) => {
        reject(err);
      })
      .connect({
        host,
        port,
        username: user,
        privateKey,
      });
  });
}
