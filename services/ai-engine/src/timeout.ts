/** Promise.race timeout — mirrors legacy/timeouts.py semantics. */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function nowMs(): number {
  return Date.now();
}
