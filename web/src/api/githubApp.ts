import { api } from "./client.js";

export interface GithubAppSummary {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string | null;
}

export interface GithubInstallationSummary {
  installationId: number;
  accountLogin: string;
  accountType: string | null;
  repositorySelection: "all" | "selected";
  repoCount: number;
}

export interface GithubAppState {
  registered: boolean;
  encryptionKeyConfigured: boolean;
  app?: GithubAppSummary | null;
  installUrl?: string | null;
  installations: GithubInstallationSummary[];
}

export interface ManifestHandoff {
  action: string;
  state: string;
  manifest: Record<string, unknown>;
}

export const githubAppApi = {
  state: () => api.get<GithubAppState>("/github/app"),
  manifest: (body: { name: string; org?: string | null }) =>
    api.post<ManifestHandoff>("/github/app/manifest", body),
};

/**
 * Hand the manifest to GitHub.
 *
 * This has to be a real, top-level form POST to github.com. It cannot be a
 * `fetch` — GitHub's registration page is what the operator has to see and
 * confirm, and the escalating-cost click stays in their hands on GitHub's own
 * domain (ADR-0006 [5]). A cross-origin fetch would also simply be blocked.
 */
export function submitManifest(handoff: ManifestHandoff): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = handoff.action;

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(handoff.manifest);

  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}
