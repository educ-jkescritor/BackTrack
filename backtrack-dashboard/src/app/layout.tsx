import type { Metadata } from "next";
import "./globals.css";
import Walkthrough from "./components/Walkthrough";

export const metadata: Metadata = {
  title: "BackTrack — Telemetry & Self-Healing",
  description: "Local-first observability and self-healing for Kubernetes & Docker.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        {children}
        {/* Interactive demo overlay — pure UI, zero data-flow impact */}
        <Walkthrough />
      </body>
    </html>
  );
}

