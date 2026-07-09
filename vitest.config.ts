import { defineConfig } from "vitest/config";

// Server-side test suite (T0-1). Kept deliberately small in scope:
//  - `forks` pool + no file parallelism, because better-sqlite3 is a native
//    module and the integration suite shares one on-disk test database.
//  - DISPATCH_DB_PATH is read at module load by server/db/migrate.ts, so it must
//    be set here rather than in a beforeAll hook. `data/` is gitignored.
//
// `web/**` covers pure logic only (T1-6's verdict rule) — no DOM, no component
// rendering, so `environment: node` still holds and no jsdom/testing-library
// dependency is pulled in. Components stay verified by typecheck and by eye.
export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "web/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    env: {
      DISPATCH_DB_PATH: "data/test-dispatch.db",
    },
  },
});
