import { Page } from "../components/Page.js";

// Renders the pipeline architecture diagram (served as a static asset from
// web/public/pipeline.html, kept in sync with docs/pipeline-architecture-diagram.html).
export function ArchitecturePage() {
  return (
    <Page title="Pipeline Architecture">
      <p className="mb-3 text-body text-gray-400">
        How a ticket flows from spec chat to production — including build auth (a Claude
        subscription token, not the API key), the stack-aware CI gate, and the staging
        approval gate.
      </p>
      <div className="overflow-auto rounded-lg border border-border bg-bg">
        <iframe
          title="Dispatch pipeline architecture"
          src="/pipeline.html"
          className="block w-full"
          style={{ height: 940, border: 0 }}
        />
      </div>
    </Page>
  );
}
