import { describe, it, expect } from "vitest";
import { tryParseTicket, stripFences } from "./ticket-json.js";

// T0-4 — the ticket parser stands between a language model's free text and a
// real issue filed on someone's repo. PRD acceptance #3 requires 10 consecutive
// generations with 0 unhandled parse failures, which means this function must
// return null (→ retry) rather than throw, for every shape of garbage.

const valid = { title: "Add a thing", body_markdown: "## Problem\n\nIt is missing.", labels: ["bug"] };

describe("stripFences", () => {
  it("strips a ```json fence", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a bare ``` fence", () => {
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves unfenced text alone", () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("tryParseTicket", () => {
  it("parses bare JSON", () => {
    expect(tryParseTicket(JSON.stringify(valid))).toEqual(valid);
  });

  it("parses fenced JSON", () => {
    expect(tryParseTicket("```json\n" + JSON.stringify(valid) + "\n```")).toEqual(valid);
  });

  it("parses JSON wrapped in prose on both sides", () => {
    const text = `Sure! Here is the ticket:\n\n${JSON.stringify(valid)}\n\nLet me know if you want changes.`;
    expect(tryParseTicket(text)).toEqual(valid);
  });

  it("defaults labels to [] when absent", () => {
    const text = JSON.stringify({ title: "T", body_markdown: "B" });
    expect(tryParseTicket(text)).toEqual({ title: "T", body_markdown: "B", labels: [] });
  });

  it("drops non-string labels rather than failing", () => {
    const text = JSON.stringify({ title: "T", body_markdown: "B", labels: ["ok", 3, null, "fine"] });
    expect(tryParseTicket(text)?.labels).toEqual(["ok", "fine"]);
  });

  it("coerces a non-array labels field to []", () => {
    const text = JSON.stringify({ title: "T", body_markdown: "B", labels: "bug" });
    expect(tryParseTicket(text)?.labels).toEqual([]);
  });

  describe("returns null (never throws) for unusable input", () => {
    it.each([
      ["empty string", ""],
      ["prose only", "I need more information before I can write that ticket."],
      ["malformed JSON", '{"title": "T", "body_markdown":'],
      ["JSON array", "[1,2,3]"],
      ["JSON null", "null"],
      ["missing title", JSON.stringify({ body_markdown: "B" })],
      ["missing body_markdown", JSON.stringify({ title: "T" })],
      ["title is not a string", JSON.stringify({ title: 7, body_markdown: "B" })],
      ["body_markdown is not a string", JSON.stringify({ title: "T", body_markdown: [] })],
      ["unterminated fence", '```json\n{"title":"T"'],
    ])("%s", (_label, input) => {
      expect(tryParseTicket(input)).toBeNull();
    });
  });

  // The brace-slicing fallback must not corrupt valid content: a body containing
  // braces should survive intact.
  it("preserves braces inside body_markdown", () => {
    const ticket = { title: "T", body_markdown: "use `{ foo: 1 }` here", labels: [] };
    expect(tryParseTicket("Here you go:\n" + JSON.stringify(ticket))).toEqual(ticket);
  });
});
