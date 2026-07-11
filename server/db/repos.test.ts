import { beforeEach, describe, expect, it } from "vitest";
import { getDb, migrateRepoIdentity, addCanaryColumns } from "./migrate.js";
import { insertRepo, listRepos, findRepoByIdentity, getRepo, updateCanaryVerdict } from "./repos.js";
import { resetDb } from "../test/helpers.js";

// #23 — `UNIQUE (provider, host, path)` never fired for GitHub repos.
//
// SQLite treats NULL as distinct from every other NULL inside a UNIQUE index,
// and GitHub repos always carry `host = NULL`. So the constraint silently
// allowed a second row, and every click of Track appended one. GitLab repos
// (non-null host) were always deduped, which is why this hid for so long.

describe("repo identity is unique, even when host is NULL", () => {
  beforeEach(() => resetDb());

  it("refuses a second GitHub row for the same path (host NULL)", () => {
    const first = insertRepo({ provider: "github", host: null, path: "acme/widgets" });

    expect(() => insertRepo({ provider: "github", host: null, path: "acme/widgets" })).toThrow(
      /UNIQUE|constraint/i
    );

    const rows = listRepos();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
  });

  it("treats an omitted host and an explicit null host as the same repo", () => {
    insertRepo({ provider: "github", path: "acme/widgets" });
    expect(() => insertRepo({ provider: "github", host: null, path: "acme/widgets" })).toThrow(
      /UNIQUE|constraint/i
    );
    expect(listRepos()).toHaveLength(1);
  });

  it("still separates the same path on different providers", () => {
    insertRepo({ provider: "github", host: null, path: "acme/widgets" });
    insertRepo({ provider: "gitlab", host: null, path: "acme/widgets" });
    expect(listRepos()).toHaveLength(2);
  });

  it("still separates the same path on different GitLab hosts", () => {
    insertRepo({ provider: "gitlab", host: "https://gitlab.com", path: "acme/widgets" });
    insertRepo({ provider: "gitlab", host: "https://git.internal", path: "acme/widgets" });
    expect(listRepos()).toHaveLength(2);
  });

  it("findRepoByIdentity matches a NULL host via an omitted host", () => {
    const row = insertRepo({ provider: "github", host: null, path: "acme/widgets" });
    expect(findRepoByIdentity("github", null, "acme/widgets")?.id).toBe(row.id);
    expect(findRepoByIdentity("github", undefined, "acme/widgets")?.id).toBe(row.id);
    expect(findRepoByIdentity("github", null, "acme/other")).toBeUndefined();
    expect(findRepoByIdentity("gitlab", null, "acme/widgets")).toBeUndefined();
  });
});

describe("canary verdict persistence (#5)", () => {
  beforeEach(() => resetDb());

  it("round-trips verdict, reason, and timestamp on the repo row", () => {
    const repo = insertRepo({ provider: "github", path: "acme/widgets" });
    updateCanaryVerdict(repo.id, {
      verdict: "fail",
      reason: "parked awaiting approval",
      checkedAt: "2026-07-11T00:00:00Z",
    });

    const row = getRepo(repo.id)!;
    expect(row.canary_verdict).toBe("fail");
    expect(row.canary_reason).toBe("parked awaiting approval");
    expect(row.canary_checked_at).toBe("2026-07-11T00:00:00Z");
  });

  it("back-fills a pre-canary database and is idempotent on re-run", () => {
    const db = getDb();
    // Manufacture a database created before this column existed.
    db.exec("ALTER TABLE repos DROP COLUMN canary_verdict");
    db.exec("ALTER TABLE repos DROP COLUMN canary_reason");
    db.exec("ALTER TABLE repos DROP COLUMN canary_checked_at");

    addCanaryColumns(db);
    addCanaryColumns(db); // boot runs this every time; the second call must be a no-op

    const cols = (db.pragma("table_info(repos)") as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["canary_verdict", "canary_reason", "canary_checked_at"])
    );
  });
});

describe("the migration collapses pre-existing duplicates", () => {
  beforeEach(() => resetDb());

  it("keeps the lowest id, re-points child rows, and drops the rest", () => {
    const db = getDb();
    // Reach past insertRepo to manufacture the corrupt state the index now
    // forbids — this is exactly what a pre-#23 database looks like on disk.
    db.exec("DROP INDEX IF EXISTS idx_repos_identity");
    const mk = db.prepare("INSERT INTO repos (provider, host, path) VALUES (?, NULL, ?)");
    const keep = Number(mk.run("github", "acme/widgets").lastInsertRowid);
    const dup1 = Number(mk.run("github", "acme/widgets").lastInsertRowid);
    const dup2 = Number(mk.run("github", "acme/widgets").lastInsertRowid);
    expect(listRepos()).toHaveLength(3);

    // A ticket hanging off each duplicate must survive, re-pointed at `keep`.
    const mkTicket = db.prepare(
      "INSERT INTO tickets (repo_id, issue_number, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')"
    );
    mkTicket.run(keep, 1);
    mkTicket.run(dup1, 2);
    mkTicket.run(dup2, 3);

    // Re-running the migration is what boot does.
    migrateRepoIdentity(db);

    const rows = listRepos();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(keep);
    expect(getRepo(dup1)).toBeUndefined();
    expect(getRepo(dup2)).toBeUndefined();

    const issues = db
      .prepare("SELECT issue_number FROM tickets WHERE repo_id = ? ORDER BY issue_number")
      .all(keep) as { issue_number: number }[];
    expect(issues.map((t) => t.issue_number)).toEqual([1, 2, 3]);

    // And the index is in place afterwards, so it cannot happen again.
    expect(() => mk.run("github", "acme/widgets")).toThrow(/UNIQUE|constraint/i);
  });
});
