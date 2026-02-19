import { env, csvEnv } from "@/app/lib/env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function sshExec(command: string) {
  "use step";

  const host = env("SSH_HOST");
  const user = env("SSH_USER");
  const port = Number(env("SSH_PORT") ?? "22");

  if (!host || !user) {
    throw new Error("SSH not configured (SSH_HOST/SSH_USER).");
  }

  const allowedPrefixes = csvEnv("SSH_ALLOWED_PREFIXES");
  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((p) => command.startsWith(p))) {
    throw new Error(`SSH command not allowed by policy. Allowed prefixes: ${allowedPrefixes.join(", ")}`);
  }

  // Use your local ssh agent or a key file path env var (recommended)
  const keyPath = env("SSH_KEY_PATH"); // e.g. /Users/weave1/.ssh/clawdbot_key

  const args = [
    "-p", String(port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    ...(keyPath ? ["-i", keyPath] : []),
    `${user}@${host}`,
    command,
  ];

  const { stdout, stderr } = await execFileAsync("ssh", args, { timeout: 60_000 });

  return (stdout || stderr || "").toString();
}
