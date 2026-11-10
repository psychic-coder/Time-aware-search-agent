import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Time-Aware Search Agent",
  description: "A chat agent that remembers when you asked, and checks what changed since.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0d" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-dvh overflow-hidden bg-white text-zinc-900 antialiased dark:bg-[#0b0b0d] dark:text-zinc-100">
        {children}
      </body>
    </html>
  );
}
