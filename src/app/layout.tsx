import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@/components/imports.css";
import "./refinement.css";
import "./stage3.css";
export const metadata: Metadata = {
  title: "鲜配助手 · 手动配货与称重",
  description: "鲜货店的每日订单、配货与称重助手",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#235846",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hans" data-font-size="large">
      <body>{children}</body>
    </html>
  );
}
