import { useLayoutEffect, useRef, useState } from "react";
import { Page } from "../components/Page.js";

// The diagram is a fixed 1280px canvas (+24px body padding each side) — wider
// than the page's own max-w-6xl (1152px) content area, so it never fits as-is.
const DIAGRAM_WIDTH = 1328;
const DIAGRAM_HEIGHT = 932;

// Renders the pipeline architecture diagram (served as a static asset from
// web/public/pipeline.html, kept in sync with docs/pipeline-architecture-diagram.html).
export function ArchitecturePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setScale(Math.min(1, entry.contentRect.width / DIAGRAM_WIDTH));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Page title="Pipeline Architecture">
      <p className="mb-3 text-body text-gray-400">
        How a ticket flows from spec chat to production — including build auth (a Claude
        subscription token, not the API key), the stack-aware CI gate, and the staging
        approval gate.
      </p>
      {/* Scale the fixed-size diagram down to fit the available width so the whole
          graphic is visible without horizontal scrolling, and disable the iframe's
          own scrolling so there's no nested/double scrollbar. */}
      <div
        ref={containerRef}
        className="overflow-hidden rounded-lg border border-border bg-bg"
        style={{ height: DIAGRAM_HEIGHT * scale }}
      >
        <iframe
          title="Dispatch pipeline architecture"
          src="/pipeline.html"
          scrolling="no"
          className="block origin-top-left"
          style={{
            width: DIAGRAM_WIDTH,
            height: DIAGRAM_HEIGHT,
            border: 0,
            transform: `scale(${scale})`,
          }}
        />
      </div>
    </Page>
  );
}
