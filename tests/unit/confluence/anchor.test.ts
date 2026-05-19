import { describe, expect, it } from "vitest";
import { projectStorageToText, resolveAnchor } from "../../../src/confluence/anchor.js";

describe("anchor / projectStorageToText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(projectStorageToText("<p>Hello <strong>world</strong>!</p>")).toBe("Hello world !");
  });

  it("decodes common entities", () => {
    expect(projectStorageToText("<p>R&amp;D &lt;ops&gt;</p>")).toBe("R&D <ops>");
  });

  it("decodes numeric character references", () => {
    expect(projectStorageToText("<p>caf&#233;</p>")).toBe("café");
  });

  it("returns text across element boundaries in order", () => {
    const xhtml = "<p>Run <strong>kafka</strong>-<em>connect</em> on prod.</p>";
    expect(projectStorageToText(xhtml)).toBe("Run kafka - connect on prod.");
  });

  it("drops comments and CDATA wrappers", () => {
    expect(projectStorageToText("<!-- secret -->visible<![CDATA[ also visible ]]>")).toBe(
      "visible also visible",
    );
  });

  it("returns empty string for empty input", () => {
    expect(projectStorageToText("")).toBe("");
  });
});

describe("anchor / resolveAnchor", () => {
  const body = "<p>Run the <strong>kafka</strong> consumer. Then run the kafka producer once.</p>";

  it("returns found when marker appears exactly once", () => {
    const out = resolveAnchor(body, "consumer");
    expect(out.status).toBe("found");
    if (out.status === "found") {
      expect(out.occurrence).toBe(1);
      expect(out.total_matches).toBe(1);
    }
  });

  it("returns not_found when marker is absent", () => {
    const out = resolveAnchor(body, "Cassandra");
    expect(out).toMatchObject({ status: "not_found", text_marker: "Cassandra" });
  });

  it("returns ambiguous when marker matches >1 without occurrence", () => {
    const out = resolveAnchor(body, "kafka");
    expect(out.status).toBe("ambiguous");
    if (out.status === "ambiguous") expect(out.count).toBe(2);
  });

  it("selects the Nth match when occurrence is provided", () => {
    const out = resolveAnchor(body, "kafka", 2);
    expect(out.status).toBe("found");
    if (out.status === "found") {
      expect(out.occurrence).toBe(2);
      expect(out.total_matches).toBe(2);
      // The second "kafka" starts after the first; match_end is start+len.
      expect(out.match_end - out.match_start).toBe("kafka".length);
    }
  });

  it("treats an out-of-range occurrence as ambiguous", () => {
    const out = resolveAnchor(body, "kafka", 5);
    expect(out.status).toBe("ambiguous");
  });

  it("matches text spanning element boundaries via projection", () => {
    // "kafka consumer" spans the </strong> tag in the body. The projection collapses to plain text,
    // and we match against that projection.
    const out = resolveAnchor(body, "kafka consumer");
    expect(out.status).toBe("found");
  });

  it("returns not_found for empty marker", () => {
    expect(resolveAnchor(body, "").status).toBe("not_found");
  });

  it("findAllOccurrences picks last occurrence via `last` semantics", () => {
    const long = "x".repeat(5) + "marker" + "y".repeat(3) + "marker" + "z" + "marker";
    const out = resolveAnchor(long, "marker", 3);
    expect(out.status).toBe("found");
    if (out.status === "found") {
      expect(out.occurrence).toBe(3);
      expect(out.total_matches).toBe(3);
    }
  });
});
