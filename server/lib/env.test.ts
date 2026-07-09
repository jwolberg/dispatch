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
      "Mount a volume at /var/lib/dispatch"
    );
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
