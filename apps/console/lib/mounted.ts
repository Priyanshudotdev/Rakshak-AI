"use client";

import { useEffect, useState } from "react";

/**
 * True only after client hydration. Gate any rendered text that depends on
 * client-only state (clock, timezone, permissions, media devices) behind this
 * so the server HTML and first client render agree exactly — otherwise React
 * throws a hydration mismatch and the page crashes.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
