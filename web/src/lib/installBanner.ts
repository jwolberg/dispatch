// What to say after GitHub bounces the operator back from an App install (#2).
//
// The server redirects to `/repos?installed=<id>` on success, and
// `/repos?install=pending` when GitHub reported `setup_action=request` — a
// non-admin asked an org owner to approve, and nothing is installed yet. Saying
// "installed" there would be a lie the operator only discovers when their first
// ticket sits in Queued forever.

export function installBannerFor(search: string): string | null {
  const params = new URLSearchParams(search);

  if (params.get("install") === "pending") {
    return (
      "Installation requested. An organization owner has to approve it on GitHub before " +
      "Dispatch can use the App — until then, repos keep using GITHUB_TOKEN."
    );
  }

  const installed = params.get("installed");
  if (installed && /^\d+$/.test(installed)) {
    return "GitHub App installed. Repos on that account now use the App instead of GITHUB_TOKEN.";
  }

  return null;
}
