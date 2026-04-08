import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RedisClient = any;

type VfsNode =
  | {
      type: "file";
      path: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "dir";
      path: string;
      createdAt: string;
      updatedAt: string;
    };

type RouteParams = {
  path?: string[];
};

let redisClientPromise: Promise<RedisClient | null> | null = null;

async function getRedisClient(): Promise<RedisClient | null> {
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const url =
        process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
      const token =
        process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

      if (!url || !token) return null;

      const { Redis } = await import("@upstash/redis");
      return new Redis({ url, token });
    })().catch(() => null);
  }

  return redisClientPromise;
}

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(String(text ?? ""));
}

function toWebCryptoBufferSource(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle API is not available in this runtime");
  }

  const key = await subtle.importKey(
    "raw",
    toWebCryptoBufferSource(utf8ToBytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await subtle.sign("HMAC", key, toWebCryptoBufferSource(utf8ToBytes(message)));
  return hexFromBytes(new Uint8Array(sig));
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = utf8ToBytes(a);
  const bBytes = utf8ToBytes(b);

  if (aBytes.length !== bBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }

  return diff === 0;
}

function sanitizePath(inputPath: string): string {
  let p = String(inputPath ?? "").trim();
  if (!p) p = "/workspace";
  if (!p.startsWith("/")) p = `/workspace/${p}`;
  p = p.replace(/\/+/g, "/");

  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }

  return `/${out.join("/")}`;
}

function safeFilenameSegment(value: string): string {
  const s = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "file";
}

function inferMimeFromFilename(name: string): string {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    html: "text/html; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    yml: "text/yaml; charset=utf-8",
    yaml: "text/yaml; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    zip: "application/zip",
  };

  return map[ext] ?? "application/octet-stream";
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = String(base64 ?? "").replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(clean, "base64"));
}

function vfsNamespace(userId: string, sessionId: string): string {
  return `vfs:${userId}:${sessionId}`;
}

function vfsNodeKey(userId: string, sessionId: string, path: string): string {
  return `${vfsNamespace(userId, sessionId)}:node:${sanitizePath(path)}`;
}

async function vfsGetNode(
  redis: RedisClient,
  userId: string,
  sessionId: string,
  path: string
): Promise<VfsNode | undefined> {
  const p = sanitizePath(path);
  const node = await redis.get(vfsNodeKey(userId, sessionId, p));
  if (!node) return undefined;
  return node as VfsNode;
}

function buildSignedVfsPayload(args: {
  userId: string;
  sessionId: string;
  path: string;
  expiresAt: number;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "base64";
  download: boolean;
}): string {
  return [
    "v1",
    `userId=${args.userId}`,
    `sessionId=${args.sessionId}`,
    `path=${sanitizePath(args.path)}`,
    `expires=${args.expiresAt}`,
    `filename=${args.filename}`,
    `mimeType=${args.mimeType}`,
    `encoding=${args.encoding}`,
    `download=${args.download ? "1" : "0"}`,
  ].join("\n");
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function forbidden(message: string): Response {
  return new Response(message, { status: 403 });
}

function notFound(message: string): Response {
  return new Response(message, { status: 404 });
}

async function handle(
  request: NextRequest,
  { params }: { params: Promise<RouteParams> },
  head = false
): Promise<Response> {
  const secret =
    process.env.VFS_URL_SIGNING_SECRET ??
    process.env.ASSET_URL_SIGNING_SECRET ??
    process.env.SESSION_ASSET_SIGNING_SECRET ??
    "";

  if (!secret) {
    return new Response(
      "Missing VFS_URL_SIGNING_SECRET (or ASSET_URL_SIGNING_SECRET / SESSION_ASSET_SIGNING_SECRET)",
      { status: 500 }
    );
  }

  const redis = await getRedisClient();
  if (!redis) {
    return new Response(
      "Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.",
      { status: 500 }
    );
  }

  const resolvedParams = await params;
  const requestedPath = sanitizePath(`/${(resolvedParams.path ?? []).join("/")}`);

  const searchParams = request.nextUrl.searchParams;
  const userId = String(searchParams.get("userId") ?? "").trim();
  const sessionId = String(searchParams.get("sessionId") ?? "").trim();
  const expiresRaw = String(searchParams.get("expires") ?? "").trim();
  const sig = String(searchParams.get("sig") ?? "").trim();
  const filename = safeFilenameSegment(
    String(searchParams.get("filename") ?? requestedPath.split("/").pop() ?? "file")
  );
  const mimeType = String(
    searchParams.get("mimeType") ?? inferMimeFromFilename(filename) ?? "application/octet-stream"
  )
    .trim()
    .toLowerCase();
  const encoding = searchParams.get("encoding") === "base64" ? "base64" : "utf8";
  const download = searchParams.get("download") === "1";

  if (!userId) return badRequest("Missing userId");
  if (!sessionId) return badRequest("Missing sessionId");
  if (!expiresRaw) return badRequest("Missing expires");
  if (!sig) return badRequest("Missing sig");

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) {
    return badRequest("Invalid expires");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expiresAt < nowSeconds) {
    return forbidden("Signed URL expired");
  }

  const expectedSig = await hmacSha256Hex(
    secret,
    buildSignedVfsPayload({
      userId,
      sessionId,
      path: requestedPath,
      expiresAt,
      filename,
      mimeType,
      encoding,
      download,
    })
  );

  if (!constantTimeEquals(expectedSig, sig)) {
    return forbidden("Invalid signature");
  }

  const node = await vfsGetNode(redis, userId, sessionId, requestedPath);
  if (!node) {
    return notFound(`No such file: ${requestedPath}`);
  }
  if (node.type !== "file") {
    return badRequest(`Not a file: ${requestedPath}`);
  }

  const headers = new Headers();
  headers.set("content-type", mimeType || inferMimeFromFilename(filename));
  headers.set(
    "content-disposition",
    `${download ? "attachment" : "inline"}; filename="${filename}"`
  );
  headers.set("cache-control", "private, max-age=60");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("x-vfs-path", requestedPath);
  headers.set("x-vfs-user-id", userId);
  headers.set("x-vfs-session-id", sessionId);

  if (head) {
    return new Response(null, { status: 200, headers });
  }

  try {
    if (encoding === "base64") {
      const bytes = base64ToBytes(node.content);
      return new Response(bytes, { status: 200, headers });
    }

    return new Response(node.content, { status: 200, headers });
  } catch (error: any) {
    return new Response(
      `Failed to serve VFS file: ${String(error?.message ?? error ?? "Unknown error")}`,
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<RouteParams> }
): Promise<Response> {
  return await handle(request, context, false);
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<RouteParams> }
): Promise<Response> {
  return await handle(request, context, true);
}
