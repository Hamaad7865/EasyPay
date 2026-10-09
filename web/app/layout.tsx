import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import { THEME_COOKIE, themeOf } from "@/lib/theme";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = { title: "EasyPay back office" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // the look chosen in this browser, known before the page is drawn; with none
  // chosen there is no mark and the device's own setting decides (lib/theme.ts)
  const theme = themeOf((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className={inter.variable} data-theme={theme ?? undefined}>
      <body>{children}</body>
    </html>
  );
}
