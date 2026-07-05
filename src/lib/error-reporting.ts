// Client-side error reporting hook for the root error boundary.
// Wire this up to your own monitoring service (e.g. Sentry) if desired.

export function reportClientError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  console.error("[error-boundary]", error, context);
}
