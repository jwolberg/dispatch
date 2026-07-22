// #39 — transition-only logging for the account-level probes.
//
// The rate-limit probe runs every poll cycle. A credential that is expired fails
// every cycle, and the old code warned every time: production emitted 353
// identical "Bad credentials" lines in six hours, burying the fact that the same
// six hours contained 429 *successful* conditional requests via the App.
//
// Log on transition, not on state.

export class ProbeLog {
  /** Last failure message per credential; absent means "currently healthy". */
  private failing = new Map<string, string>();

  /**
   * Record a failure. Returns true when it is worth logging — the first
   * failure, or a *different* failure from the last one.
   *
   * Keying on the message rather than a boolean means a credential that starts
   * failing a new way still reports. This assumes provider errors are stable
   * strings; one carrying a request id or timestamp would defeat suppression
   * and log every cycle again. The current GitHub/GitLab messages are stable.
   */
  failed(credential: string, message: string): boolean {
    if (this.failing.get(credential) === message) return false;
    this.failing.set(credential, message);
    return true;
  }

  /**
   * Record a success. Returns true only when this credential was previously
   * failing, so recovery is logged once and healthy credentials stay silent.
   */
  recovered(credential: string): boolean {
    return this.failing.delete(credential);
  }
}
