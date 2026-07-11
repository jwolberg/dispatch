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
    const e = err as {
      status?: number;
      statusCode?: number;
      // gitbeaker (GitbeakerRequestError) hides the status on the cause's response,
      // not on the error itself — without this the GitLab adapter's isNotFound
      // guards never match a real 404.
      cause?: { response?: { status?: number } };
    };
    return e.status ?? e.statusCode ?? e.cause?.response?.status;
  }
  return undefined;
}

export function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}
