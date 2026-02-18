import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ZeroClaw Vercel Gateway",
  description: "Gateway + Workflow DevKit autonomous bot runtime",
};

import { bootstrapDev } from "@/app/bootstrap";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await bootstrapDev();  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
        {children}
      </body>
    </html>
  );
}
