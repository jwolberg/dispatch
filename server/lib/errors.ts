/** Normalized provider error carrying an HTTP status when available. */
export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number };
    return e.status ?? e.statusCode;
  }
  return undefined;
}

export function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}
