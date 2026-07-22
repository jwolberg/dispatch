import { describe, it, expect, beforeEach } from "vitest";
import { ProbeLog } from "./probe-log.js";

// #39 — production emitted 353 identical "Bad credentials" lines in six hours.
// These tests pin the transition-only contract that replaces it.

describe("ProbeLog", () => {
  let log: ProbeLog;
  beforeEach(() => {
    log = new ProbeLog();
  });

  it("reports the first failure", () => {
    expect(log.failed("env:GITHUB_TOKEN", "Bad credentials")).toBe(true);
  });

  it("stays silent while the same failure repeats", () => {
    log.failed("env:GITHUB_TOKEN", "Bad credentials");
    for (let i = 0; i < 100; i++) {
      expect(log.failed("env:GITHUB_TOKEN", "Bad credentials")).toBe(false);
    }
  });

  it("reports again when the failure mode changes", () => {
    log.failed("env:GITHUB_TOKEN", "Bad credentials");
    expect(log.failed("env:GITHUB_TOKEN", "rate limit exceeded")).toBe(true);
    // ...and then goes quiet on the new one too.
    expect(log.failed("env:GITHUB_TOKEN", "rate limit exceeded")).toBe(false);
  });

  it("tracks credentials independently", () => {
    expect(log.failed("env:GITHUB_TOKEN", "Bad credentials")).toBe(true);
    // A second credential failing the same way is separate news.
    expect(log.failed("app:acme", "Bad credentials")).toBe(true);
    expect(log.failed("env:GITHUB_TOKEN", "Bad credentials")).toBe(false);
  });

  it("reports recovery exactly once", () => {
    log.failed("env:GITHUB_TOKEN", "Bad credentials");
    expect(log.recovered("env:GITHUB_TOKEN")).toBe(true);
    expect(log.recovered("env:GITHUB_TOKEN")).toBe(false);
  });

  it("says nothing when a credential that was never failing succeeds", () => {
    expect(log.recovered("app:acme")).toBe(false);
  });

  it("reports a failure again after a recovery", () => {
    // A flapping credential must not be silenced by its own history.
    log.failed("env:GITHUB_TOKEN", "Bad credentials");
    log.recovered("env:GITHUB_TOKEN");
    expect(log.failed("env:GITHUB_TOKEN", "Bad credentials")).toBe(true);
  });
});
