import { describe, it, expect } from "vitest";
import { ephemeralDbWarning } from "./env.js";

// T0-10 — DEPLOY.md §4 warns that the SQLite file is lost on redeploy unless a
// volume is mounted at its directory. That warning belongs at boot, not only in
// a document nobody rereads.

const mounted = { allowNonLocal: true, isMountPoint: () => true };
const notMounted = { allowNonLocal: true, isMountPoint: () => false };

describe("ephemeralDbWarning", () => {
  it("stays silent in local mode, where data/ on the developer's disk is correct", () => {
    expect(
      ephemeralDbWarning("/repo/data/dispatch.db", { allowNonLocal: false, isMountPoint: () => false })
    ).toBeNull();
  });

  it("stays silent in a container when the DB directory is a mounted volume", () => {
    expect(ephemeralDbWarning("/data/dispatch.db", mounted)).toBeNull();
  });

  it("warns in a container when the DB directory is not mounted", () => {
    const warning = ephemeralDbWarning("/data/dispatch.db", notMounted);
    expect(warning).toContain("/data/dispatch.db");
    expect(warning).toContain("not on a mounted volume");
    expect(warning).toContain("DEPLOY.md");
  });

  it("names the directory to mount, not the file", () => {
    expect(ephemeralDbWarning("/var/lib/dispatch/db.sqlite", notMounted)).toContain(
      "mount a volume at /var/lib/dispatch"
    );
  });

  // #20 — a GCS snapshot makes the file durable without any volume, so the
  // warning must stop firing. A warning that cries wolf on every boot of a
  // correctly-configured service is worse than no warning.
  it("stays silent when a GCS snapshot is configured, even with no volume", () => {
    expect(ephemeralDbWarning("/data/dispatch.db", { ...notMounted, snapshotEnabled: true })).toBeNull();
  });

  it("offers the snapshot as a remedy alongside mounting a volume", () => {
    const warning = ephemeralDbWarning("/data/dispatch.db", notMounted);
    expect(warning).toContain("DISPATCH_GCS_BUCKET");
  });

  it("checks the DB's directory for mountedness, not the file path", () => {
    const seen: string[] = [];
    ephemeralDbWarning("/data/dispatch.db", {
      allowNonLocal: true,
      isMountPoint: (dir) => {
        seen.push(dir);
        return true;
      },
    });
    expect(seen).toEqual(["/data"]);
  });
});
