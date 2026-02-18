// app/lib/uiRequire.ts
import { redirect } from "next/navigation";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";

export async function requireUiAuthPage() {
  const token = await getUiCookie();
  if (!verifyUiToken(token)) redirect("/ui/login");
}
