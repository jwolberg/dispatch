import { useEffect, useRef, useState } from "react";

// Poll a fetcher on an interval. The fetcher is held in a ref so callers can
// pass an inline closure without resetting the interval each render.
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fetcher);
  fnRef.current = fetcher;

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const d = await fnRef.current();
        if (active) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { data, error };
}
