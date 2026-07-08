/** Unified deadline read for game_sessions.state (deadlineAt | phaseDeadlineAt). */

export function sessionDeadlineMs(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  const raw = s.phaseDeadlineAt ?? s.deadlineAt;
  if (typeof raw !== "string" || !raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isSessionDue(state: unknown, now = Date.now()): boolean {
  const deadline = sessionDeadlineMs(state);
  return deadline !== null && now >= deadline;
}
