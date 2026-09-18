"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSession } from "@/lib/api";

/** Root: signed-in operators go to /home, everyone else to /login. */
export default function RootPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getSession() ? "/home" : "/login");
  }, [router]);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper">
      <p className="text-sm text-muted">Loading Rakshak AI…</p>
    </main>
  );
}
