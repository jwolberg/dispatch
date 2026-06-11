import { Page } from "../components/Page.js";

// Renders the pipeline architecture diagram (served as a static asset from
// web/public/pipeline.html, kept in sync with docs/pipeline-architecture-diagram.html).
export function ArchitecturePage() {
  return (
    <Page title="Pipeline Architecture">
      <p className="mb-3 text-body text-gray-400">
        How a ticket flows from spec chat to production — and where CI tests and the
        staging gate sit.
      </p>
      <div className="overflow-auto rounded-lg border border-border bg-bg">
        <iframe
          title="Dispatch pipeline architecture"
          src="/pipeline.html"
          className="block w-full"
          style={{ height: 880, border: 0 }}
        />
      </div>
    </Page>
  );
}
