import dotenv from "dotenv";

dotenv.config();

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface AppConfig {
  port: number;
  host: string;
}

/**
 * Resolve runtime configuration and enforce the localhost bind guard (S1).
 *
 * The backend binds to 127.0.0.1 by default. Binding to any non-local
 * interface requires ALLOW_NONLOCAL=1; otherwise startup is refused.
 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const host = process.env.HOST?.trim() || "127.0.0.1";
  const allowNonLocal = process.env.ALLOW_NONLOCAL === "1";

  if (!LOCAL_HOSTS.has(host) && !allowNonLocal) {
    throw new Error(
      `Refusing to bind to non-local host "${host}". ` +
        `Dispatch is local-first and binds to 127.0.0.1 by default. ` +
        `Set ALLOW_NONLOCAL=1 to override.`
    );
  }

  return { port, host };
}
