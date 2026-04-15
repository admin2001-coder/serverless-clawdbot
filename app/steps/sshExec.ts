import { env, csvEnv } from "@/app/lib/env";

export async function sshExec(command: string): Promise<string> {
  "use step";

  const { Client } = await import("ssh2");

  const host = env("SSH_HOST");
  const user = env("SSH_USER");
  const port = Number(env("SSH_PORT") ?? "22");
  const privateKey = env("SSH_PRIVATE_KEY");

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

  return await new Promise((resolve, reject) => {
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
      .on("error", reject)
      .connect({
        host,
        port,
        username: user,
        privateKey,
      });
  });
}
