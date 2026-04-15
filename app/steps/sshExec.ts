import { createHash } from "node:crypto";
import { env, csvEnv } from "@/app/lib/env";

function sha256Base64(buf: Buffer) {
  return createHash("sha256").update(buf).digest("base64");
}

export async function sshExec(command: string): Promise<string> {
  "use step";

  const { Client } = await import("ssh2");

  const host = env("SSH_HOST");
  const user = env("SSH_USER");
  const port = Number(env("SSH_PORT") ?? "22");
  const privateKey = env("SSH_PRIVATE_KEY");
  const expectedHostKeySha256 = env("SSH_HOST_KEY_SHA256"); // base64 only, no "SHA256:" prefix
  const allowUnknownHost = (env("SSH_ACCEPT_NEW_HOST") ?? "").toLowerCase() === "true";

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
        hostHash: "sha256",
        hostVerifier: (hashedKey: string | Buffer) => {
          const actual =
            typeof hashedKey === "string" ? hashedKey : sha256Base64(hashedKey);

          if (expectedHostKeySha256) {
            return actual === expectedHostKeySha256.replace(/^SHA256:/, "");
          }

          if (allowUnknownHost) {
            console.log(`Accepting new SSH host key for ${host}: SHA256:${actual}`);
            return true;
          }

          throw new Error(
            `Host key verification failed for ${host}. Set SSH_HOST_KEY_SHA256=SHA256:${actual} or enable SSH_ACCEPT_NEW_HOST=true`
          );
        },
      });
  });
}
