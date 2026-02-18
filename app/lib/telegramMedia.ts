// app/lib/telegramMedia.ts
import { envRequired } from "@/app/lib/env";

type TelegramGetFileResponse = {
  ok: boolean;
  result?: { file_path?: string };
};

export async function telegramFileIdToBase64(fileId: string): Promise<{ base64: string; mimeType: string }> {
  const token = envRequired("TELEGRAM_BOT_TOKEN");

  const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaRes = await fetch(getFileUrl);
  if (!metaRes.ok) throw new Error(`Telegram getFile failed: ${metaRes.status} ${await metaRes.text()}`);

  const meta = (await metaRes.json()) as TelegramGetFileResponse;
  const filePath = meta?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");

  const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const imgRes = await fetch(downloadUrl);
  if (!imgRes.ok) throw new Error(`Telegram file download failed: ${imgRes.status} ${await imgRes.text()}`);

  const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType };
}
