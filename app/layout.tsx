import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SWRegister } from "./sw-register";
import AppShell from "@/components/AppShell";
import { Providers } from "@/components/Providers";

const appName = "Tradeict Earner";
const description = "Tradeict Earner — Web & Mobile";

export const metadata: Metadata = {
  title: appName,
  description,
  applicationName: appName,
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: appName,
  },
  formatDetection: {
    telephone: false,
  },
  manifest: "/manifest.json",
  icons: {
    icon: "/icons/icon-512.png",
    apple: "/icons/icon-512.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head />
      <body className="antialiased min-h-screen">
        <SWRegister />
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
