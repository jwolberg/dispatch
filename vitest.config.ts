import { defineConfig } from "vitest/config";

// Server-side test suite (T0-1). Kept deliberately small in scope:
//  - `forks` pool + no file parallelism, because better-sqlite3 is a native
//    module and the integration suite shares one on-disk test database.
//  - DISPATCH_DB_PATH is read at module load by server/db/migrate.ts, so it must
//    be set here rather than in a beforeAll hook. `data/` is gitignored.
export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    env: {
      DISPATCH_DB_PATH: "data/test-dispatch.db",
    },
  },
});
