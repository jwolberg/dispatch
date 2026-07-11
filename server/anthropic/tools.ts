import type Anthropic from "@anthropic-ai/sdk";
import { redactSecrets } from "../lib/redaction.js";
import type { GitProvider, RepoRef } from "../providers/types.js";

// #27 — the spec-chat tool executor. This is the security choke point between the
// model's tool_use requests and the provider's file reads. Everything the model
// receives passes through here, so every guard the ticket names lives here:
// denylist, path safety, size cap, per-turn read cap, and redaction.
//
// A chat transcript persists to `chats`, which triggers a GCS snapshot upload, so
// a credential returned here is written to a durable, versioned bucket. The
// denylist is a floor (it cannot catch a token pasted into config.py); redaction
// is the second layer and only knows registered secrets. The residual risk — an
// unregistered secret in an allow-listed file — is accepted explicitly.

/** ~64 KB. Beyond this the model gets a truncated fragment, marked as such. */
export const MAX_FILE_BYTES = 64 * 1024;

/** A single turn may read at most this many files before further reads refuse. */
export const MAX_FILE_READS = 10;

export const SPEC_CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the repository being specced, by its repo-relative " +
      "path (e.g. 'src/config.ts'). Returns the file contents, truncated if large. Use " +
      "this to ground the spec in what the code actually does rather than guessing from " +
      "filenames.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. 'configs/config_maet.py'." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description:
      "List the entries under a repo-relative directory path (e.g. 'configs'). Use this " +
      "to discover files deeper than the shallow tree in the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative directory, e.g. 'configs' or '' for root." },
      },
      required: ["path"],
    },
  },
];

// Credentials by filename. A denylisted read is refused before the provider is
// even asked, so contents can never leave the repo boundary.
const DENYLIST: RegExp[] = [
  /(^|\/)\.env($|\.|\/)/i, //  .env, .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)credentials/i,
  /\.p12$/i,
  /\.pfx$/i,
];

function isDenylisted(path: string): boolean {
  return DENYLIST.some((re) => re.test(path));
}

// Defense in depth — the provider API is already repo-scoped, but reject the
// shapes that would try to escape it regardless.
function isUnsafePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  return path.split("/").some((seg) => seg === "..");
}

function truncate(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_FILE_BYTES) return content;
  // Slice by chars then hard-cap bytes; a marker tells the model it holds a fragment.
  const head = content.slice(0, MAX_FILE_BYTES);
  return `${head}\n\n[... truncated at ${MAX_FILE_BYTES} bytes — this is a fragment, not the whole file ...]`;
}

export interface ToolRunner {
  /** Run one tool_use block; always resolves to a string the model can read. */
  runTool: (name: string, input: unknown) => Promise<string>;
  /** Files read so far this turn (for cap enforcement / telemetry). */
  reads: () => number;
}

/**
 * Bind the spec-chat tools to one repo. The returned `runTool` never throws — a
 * refusal, a not-found, or an error all resolve to a string, because the model
 * must be able to read the outcome and continue (or give up gracefully).
 */
export function makeToolRunner(provider: GitProvider, repo: RepoRef): ToolRunner {
  let reads = 0;

  async function readFile(input: unknown): Promise<string> {
    const path = pathOf(input);
    if (path === null) return "Refused: read_file requires a string 'path'.";
    if (isUnsafePath(path)) {
      return `Refused: '${path}' is not allowed — paths must be repo-relative with no '..' segments.`;
    }
    if (isDenylisted(path)) {
      return `Refused: '${path}' may contain secrets and cannot be read. Ask about the code, not credentials.`;
    }
    if (reads >= MAX_FILE_READS) {
      return `Read limit reached (${MAX_FILE_READS} files this turn). Answer from what you have, or ask the user to narrow the question.`;
    }
    reads++;

    let content: string | null;
    try {
      content = await provider.readFile(repo, path);
    } catch (err) {
      return `Could not read '${path}': ${redactSecrets(err instanceof Error ? err.message : String(err))}`;
    }
    if (content === null) return `File not found: '${path}' does not exist in this repo.`;

    // Redaction is the LAST step, so nothing — not even a truncation marker built
    // from content — can slip a registered secret through.
    return redactSecrets(truncate(content));
  }

  async function listFiles(input: unknown): Promise<string> {
    const path = pathOf(input) ?? "";
    if (isUnsafePath(path)) {
      return `Refused: '${path}' is not allowed — paths must be repo-relative with no '..' segments.`;
    }
    let entries: string[];
    try {
      entries = await provider.listFiles(repo, path);
    } catch (err) {
      return `Could not list '${path}': ${redactSecrets(err instanceof Error ? err.message : String(err))}`;
    }
    if (entries.length === 0) return `'${path || "/"}' is empty or does not exist.`;
    return redactSecrets(entries.join("\n"));
  }

  return {
    reads: () => reads,
    runTool: async (name, input) => {
      if (name === "read_file") return readFile(input);
      if (name === "list_files") return listFiles(input);
      return `Unknown tool '${name}'.`;
    },
  };
}

function pathOf(input: unknown): string | null {
  if (input && typeof input === "object" && "path" in input) {
    const p = (input as { path: unknown }).path;
    if (typeof p === "string") return p;
  }
  return null;
}
