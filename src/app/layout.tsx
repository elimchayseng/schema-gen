import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import Navbar from "@/components/Navbar";
import AuthProvider from "@/components/AuthProvider";
import { ScanProvider } from "@/components/ScanProvider";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
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
      <body
        className={`${dmSans.variable} ${jetbrainsMono.variable} font-sans min-h-screen bg-surface-0 text-text-primary antialiased`}
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
