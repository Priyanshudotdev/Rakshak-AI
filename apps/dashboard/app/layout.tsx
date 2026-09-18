import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const season = Source_Serif_4({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-season" });

export const metadata: Metadata = {
  title: "Rakshak AI — Operator Dashboard",
  description: "Real-time emergency call intelligence for operators. AI assists; humans decide.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${season.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
