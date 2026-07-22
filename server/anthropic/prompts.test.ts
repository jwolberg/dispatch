import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type InjectableContext } from "./prompts.js";
import {
  SPEC_SKILLS,
  DEFAULT_SPEC_SKILL_ID,
  getSpecSkill,
  type SpecSkill,
} from "./spec-skills.js";

// #37 — the spec chat's operating instruction is a first-class skill, not a
// sentence. These tests pin the two things that can silently regress: the skill
// actually reaching the model, and the repo context surviving intact alongside it.

const FULL: InjectableContext = {
  path: "acme/widgets",
  description: "A widget factory",
  claudeMd: "Use tabs.",
  readmeExcerpt: "Widgets, assembled.",
  fileTree: ["src/index.ts", "src/widget.ts"],
};

const BARE: InjectableContext = {
  path: "acme/bare",
  description: null,
  claudeMd: null,
  readmeExcerpt: null,
  fileTree: [],
};

describe("spec skill registry", () => {
  it("resolves the default skill when no id is given", () => {
    expect(getSpecSkill().id).toBe(DEFAULT_SPEC_SKILL_ID);
    expect(SPEC_SKILLS[DEFAULT_SPEC_SKILL_ID]).toBeDefined();
  });

  it("falls back to the default rather than throwing on an unknown id", () => {
    // A bad id must never break a chat turn — the prompt is not user input we
    // can 400 on by the time it is assembled.
    expect(getSpecSkill("no-such-skill").id).toBe(DEFAULT_SPEC_SKILL_ID);
    expect(getSpecSkill(null).id).toBe(DEFAULT_SPEC_SKILL_ID);
  });

  it("every registered skill is complete and keyed by its own id", () => {
    for (const [key, skill] of Object.entries(SPEC_SKILLS) as [string, SpecSkill][]) {
      expect(skill.id).toBe(key);
      expect(skill.name.trim()).not.toBe("");
      expect(skill.description.trim()).not.toBe("");
      expect(skill.body.trim().length).toBeGreaterThan(200);
    }
  });

  it("credits the MIT-licensed source it was derived from", () => {
    const skill = getSpecSkill();
    expect(skill.derivedFrom).toMatch(/compound-engineering/i);
    expect(skill.derivedFrom).toMatch(/MIT/);
  });
});

describe("the default spec skill's method", () => {
  const body = getSpecSkill().body;

  it("keeps the one-question-per-turn constraint", () => {
    expect(body).toMatch(/one question/i);
  });

  it("names all four rigor gaps it should probe", () => {
    for (const gap of ["evidence", "specificity", "counterfactual", "attachment"]) {
      expect(body.toLowerCase()).toContain(gap);
    }
  });

  it("still names the spec shape the ticket generator expects", () => {
    for (const part of ["acceptance criteria", "out-of-scope", "test plan"]) {
      expect(body.toLowerCase()).toContain(part);
    }
  });
});

describe("buildSystemPrompt", () => {
  it("carries the skill body into the prompt", () => {
    expect(buildSystemPrompt(FULL)).toContain(getSpecSkill().body);
  });

  it("puts the skill before the repo context so the method frames the facts", () => {
    const prompt = buildSystemPrompt(FULL);
    expect(prompt.indexOf(getSpecSkill().body)).toBeLessThan(
      prompt.indexOf("Repository context")
    );
  });

  it("injects every populated context section", () => {
    const prompt = buildSystemPrompt(FULL);
    expect(prompt).toContain("Repository context for acme/widgets");
    expect(prompt).toContain("## Description\nA widget factory");
    expect(prompt).toContain("## CLAUDE.md\nUse tabs.");
    expect(prompt).toContain("## README (excerpt)\nWidgets, assembled.");
    expect(prompt).toContain("## File tree (depth 2)\nsrc/index.ts\nsrc/widget.ts");
  });

  it("omits empty sections rather than emitting bare headings", () => {
    const prompt = buildSystemPrompt(BARE);
    expect(prompt).toContain("Repository context for acme/bare");
    expect(prompt).not.toContain("## Description");
    expect(prompt).not.toContain("## CLAUDE.md");
    expect(prompt).not.toContain("## README (excerpt)");
    expect(prompt).not.toContain("## File tree");
  });

  it("accepts an explicit skill so a second mode is additive", () => {
    const custom: SpecSkill = {
      id: "test-only",
      name: "Test only",
      description: "d",
      derivedFrom: "n/a",
      body: "BODY-SENTINEL",
    };
    const prompt = buildSystemPrompt(FULL, custom);
    expect(prompt).toContain("BODY-SENTINEL");
    expect(prompt).not.toContain(getSpecSkill().body);
  });
});
