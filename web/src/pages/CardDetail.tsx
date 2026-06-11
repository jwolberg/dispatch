import { useParams } from "react-router-dom";
import { Page, Placeholder } from "../components/Page.js";

// Built out in P3-T7 (issue body, progress comment, PR + checks).
export function CardDetailPage() {
  const { id } = useParams();
  return (
    <Page title={`Ticket #${id ?? ""}`}>
      <Placeholder note="Card detail — coming in P3." />
    </Page>
  );
}
