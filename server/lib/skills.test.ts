import { describe, expect, it } from "vitest";
import { SKILLS, isSkill, skillPrompt } from "./skills.js";

// #28 — Dispatch's CI skills are namespaced ci-* so they coexist with a repo's
// own interactive plan/implement/debug skills. The console button ids, the
// prompt the button posts, and the deployed skill name: must all agree — a
// button posting "use the **plan** skill" against a repo whose Dispatch skill is
// named "ci-plan" would silently no-op.

describe("CI skill ids are namespaced (#28)", () => {
  it("SKILLS are the ci-* ids, never the bare interactive names", () => {
    expect(SKILLS).toEqual(["ci-plan", "ci-implement", "ci-debug"]);
    expect(isSkill("plan")).toBe(false);
    expect(isSkill("ci-plan")).toBe(true);
  });

  it("each prompt names its ci-* skill so it matches the deployed name:", () => {
    expect(skillPrompt("ci-plan", "github", 1)).toContain("**ci-plan**");
    expect(skillPrompt("ci-implement", "github", 1)).toContain("**ci-implement**");
    expect(skillPrompt("ci-debug", "github", 1)).toContain("**ci-debug**");
  });
});
