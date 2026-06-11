process.env.GITHUB_TOKEN="ghp_supersecrettoken123";
import { safeMessage } from "./server/lib/redaction.js";
console.log(safeMessage(new Error("auth failed with token ghp_supersecrettoken123 at api")));
