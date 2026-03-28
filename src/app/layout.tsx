import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";
import Navbar from "@/components/Navbar";
import AuthProvider from "@/components/AuthProvider";
import { ScanProvider } from "@/components/ScanProvider";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SchemaGen — Structured Data Optimizer",
  description:
    "AI-powered structured data optimizer for ecommerce. Scan, fix, and deploy JSON-LD schema markup.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className={`${instrumentSerif.variable} ${jetbrainsMono.variable} font-sans min-h-screen bg-surface-0 text-text-primary antialiased`}
      >
        <AuthProvider>
          <ScanProvider>
            <Navbar />
            <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
          </ScanProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
