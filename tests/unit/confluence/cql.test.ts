import { describe, expect, it } from "vitest";
import { buildCql, CqlBuildError, quoteCqlString } from "../../../src/confluence/cql.js";

describe("cql / quoting", () => {
  it("wraps in double quotes", () => {
    expect(quoteCqlString("hello")).toBe('"hello"');
  });

  it("escapes embedded double quotes", () => {
    expect(quoteCqlString('a "b" c')).toBe('"a \\"b\\" c"');
  });

  it("escapes backslashes", () => {
    expect(quoteCqlString("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes both, backslash first", () => {
    expect(quoteCqlString('a\\"b')).toBe('"a\\\\\\"b"');
  });
});

describe("cql / buildCql", () => {
  it("composes type + space + label + title + text with AND", () => {
    const out = buildCql({
      type: "page",
      space: "DEV",
      label: "runbook",
      title: "kafka",
      text: "lag spike",
    });
    expect(out).toBe(
      'type = "page" AND space = "DEV" AND label = "runbook" AND title ~ "kafka" AND text ~ "lag spike"',
    );
  });

  it("supports type=space and free text", () => {
    expect(buildCql({ type: "space", text: "platform" })).toBe(
      'type = "space" AND text ~ "platform"',
    );
  });

  it("emits creator and status fragments", () => {
    expect(buildCql({ creator: "alice@example.com", status: "current" })).toBe(
      'creator = "alice@example.com" AND status = "current"',
    );
  });

  it("normalises updated_since to a date and emits lastmodified >=", () => {
    expect(buildCql({ updated_since: "2026-04-09T12:00:00Z" })).toBe(
      'lastmodified >= "2026-04-09"',
    );
  });

  it("rejects malformed updated_since", () => {
    expect(() => buildCql({ updated_since: "yesterday" })).toThrow(CqlBuildError);
  });

  it("rejects empty args", () => {
    expect(() => buildCql({})).toThrow(CqlBuildError);
  });

  it("rejects space keys with embedded quotes or newlines", () => {
    expect(() => buildCql({ space: 'DEV" OR 1=1' })).toThrow(CqlBuildError);
    expect(() => buildCql({ space: "DEV\nother" })).toThrow(CqlBuildError);
  });

  it("escapes user input — quotes inside text don't break the query", () => {
    expect(buildCql({ text: 'kafka "lag"' })).toBe('text ~ "kafka \\"lag\\""');
  });

  it("escapes user input — backslash injection cannot escape closing quote", () => {
    expect(buildCql({ text: 'a\\' })).toBe('text ~ "a\\\\"');
  });
});
