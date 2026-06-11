import { useEffect, useRef, useState } from "react";

// Poll a fetcher on an interval. The fetcher is held in a ref so callers can
// pass an inline closure without resetting the interval each render.
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fetcher);
  fnRef.current = fetcher;

  const activeRef = useRef(true);
  const refetch = async () => {
    try {
      const d = await fnRef.current();
      if (activeRef.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (activeRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    activeRef.current = true;
    void refetch();
    const id = setInterval(() => void refetch(), intervalMs);
    return () => {
      activeRef.current = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return { data, error, refetch };
}
