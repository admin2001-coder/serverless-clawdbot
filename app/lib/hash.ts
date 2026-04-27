import crypto from "node:crypto";

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  function normalize(input: unknown): unknown {
    if (input == null) return input;
    if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "function" || typeof input === "symbol") return String(input);

    if (Array.isArray(input)) return input.map(normalize);

    if (typeof input === "object") {
      if (seen.has(input as object)) return "[Circular]";
      seen.add(input as object);

      const obj = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        out[key] = normalize(v);
      }
      return out;
    }

    return String(input);
  }

  return JSON.stringify(normalize(value));
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: unknown, length = 24): string {
  const raw = typeof value === "string" ? value : stableStringify(value);
  return sha256Hex(raw).slice(0, Math.max(8, Math.min(64, length)));
}

export function safeKeyPart(value: unknown, maxLength = 96): string {
  const s = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9:_@.+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (s || "empty").slice(0, maxLength);
}
