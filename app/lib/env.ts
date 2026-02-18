export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function envRequired(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function csvEnv(name: string): string[] {
  const v = env(name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
