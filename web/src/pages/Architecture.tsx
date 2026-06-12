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
      {/* The diagram is a fixed 1280px canvas (+24px body padding each side). Size
          the iframe to fully contain it and disable its own scrolling, so only this
          wrapper scrolls horizontally — no nested/double scrollbars. */}
      <div className="overflow-x-auto rounded-lg border border-border bg-bg">
        <iframe
          title="Dispatch pipeline architecture"
          src="/pipeline.html"
          scrolling="no"
          className="block"
          style={{ width: 1328, height: 932, border: 0 }}
        />
      </div>
    </Page>
  );
}
