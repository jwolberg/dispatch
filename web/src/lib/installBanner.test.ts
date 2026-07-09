import { describe, expect, it } from "vitest";
import { installBannerFor } from "./installBanner.js";

describe("installBannerFor", () => {
  it("says nothing on a plain visit", () => {
    expect(installBannerFor("")).toBeNull();
    expect(installBannerFor("?foo=1")).toBeNull();
  });

  it("confirms a completed install", () => {
    expect(installBannerFor("?installed=42")).toMatch(/installed/i);
  });

  it("does NOT claim an install when the operator only requested one", () => {
    // GitHub sends setup_action=request when a non-admin asks an org owner to
    // approve. Nothing is installed. Saying otherwise means the operator finds out
    // when their first ticket sits in Queued forever.
    const banner = installBannerFor("?install=pending");
    expect(banner).toMatch(/approve/i);
    expect(banner).not.toMatch(/App installed/);
  });

  it("ignores a non-numeric installed id rather than rendering it", () => {
    expect(installBannerFor("?installed=<script>")).toBeNull();
    expect(installBannerFor("?installed=")).toBeNull();
  });
});
