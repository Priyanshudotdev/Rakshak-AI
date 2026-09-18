import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const interTight = Inter_Tight({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Rakshak AI — Operator Console",
  description: "Emergency-call translation and response for operators. AI assists; humans decide.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${interTight.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
