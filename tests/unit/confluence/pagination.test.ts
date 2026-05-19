import { describe, expect, it } from "vitest";
import {
  v1InputFromPagination,
  v1Paginate,
  v1QueryString,
  v2ExtractNextCursor,
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
} from "../../../src/confluence/pagination.js";

describe("pagination / v2", () => {
  it("v2InputFromPagination passes cursor + pagelen → limit", () => {
    expect(v2InputFromPagination({ cursor: "ABC", pagelen: 50 })).toEqual({ cursor: "ABC", limit: 50 });
    expect(v2InputFromPagination({ pagelen: 25 })).toEqual({ limit: 25 });
  });

  it("v2QueryString includes limit (and cursor if present) plus extras", () => {
    const qs = v2QueryString({ limit: 25 }, { sort: "-modified" });
    const params = new URLSearchParams(qs);
    expect(params.get("limit")).toBe("25");
    expect(params.get("sort")).toBe("-modified");
    expect(params.has("cursor")).toBe(false);

    const qs2 = v2QueryString({ cursor: "XYZ", limit: 10 });
    const params2 = new URLSearchParams(qs2);
    expect(params2.get("cursor")).toBe("XYZ");
    expect(params2.get("limit")).toBe("10");
  });

  it("v2ExtractNextCursor reads `cursor` from a relative URL", () => {
    expect(v2ExtractNextCursor("/wiki/api/v2/pages?cursor=NEXT123&limit=25")).toBe("NEXT123");
  });

  it("v2ExtractNextCursor handles a bare query string", () => {
    expect(v2ExtractNextCursor("?cursor=BARE&limit=5")).toBe("BARE");
  });

  it("v2ExtractNextCursor returns null when no cursor", () => {
    expect(v2ExtractNextCursor(null)).toBeNull();
    expect(v2ExtractNextCursor(undefined)).toBeNull();
    expect(v2ExtractNextCursor("/wiki/api/v2/pages?limit=25")).toBeNull();
  });

  it("v2Paginate maps results and propagates next_cursor (first page)", () => {
    const body = {
      results: [{ id: "1" }, { id: "2" }],
      _links: { next: "/wiki/api/v2/pages?cursor=PAGE2&limit=25" },
    };
    const out = v2Paginate(body, (r) => ({ id: r.id }));
    expect(out.values).toEqual([{ id: "1" }, { id: "2" }]);
    expect(out.next_cursor).toBe("PAGE2");
  });

  it("v2Paginate yields next_cursor=null on last page", () => {
    const body = { results: [{ id: "3" }], _links: { next: null } };
    const out = v2Paginate(body, (r) => r);
    expect(out.next_cursor).toBeNull();
  });
});

describe("pagination / v1", () => {
  it("v1InputFromPagination prefers cursor when it's a v1 cursor", () => {
    expect(v1InputFromPagination({ cursor: "v1:50", pagelen: 25 })).toEqual({ start: 50, limit: 25 });
  });

  it("v1InputFromPagination falls back to page when no v1 cursor", () => {
    expect(v1InputFromPagination({ page: 3, pagelen: 10 })).toEqual({ start: 20, limit: 10 });
  });

  it("v1InputFromPagination ignores non-v1 cursors and falls back to start=0", () => {
    expect(v1InputFromPagination({ cursor: "ABC", pagelen: 25 })).toEqual({ start: 0, limit: 25 });
  });

  it("v1InputFromPagination defaults to start=0 when nothing given", () => {
    expect(v1InputFromPagination({ pagelen: 25 })).toEqual({ start: 0, limit: 25 });
  });

  it("v1QueryString builds start + limit + extras", () => {
    const params = new URLSearchParams(v1QueryString({ start: 10, limit: 5 }, { cql: 'type = "page"' }));
    expect(params.get("start")).toBe("10");
    expect(params.get("limit")).toBe("5");
    expect(params.get("cql")).toBe('type = "page"');
  });

  it("v1Paginate produces a v1 cursor for next page and exposes total", () => {
    const body = {
      results: [{ id: "a" }, { id: "b" }],
      start: 0,
      limit: 2,
      size: 7,
      _links: { next: "/rest/api/content?start=2&limit=2" },
    };
    const out = v1Paginate(body, (r) => r);
    expect(out.next_cursor).toBe("v1:2");
    expect(out.total).toBe(7);
  });

  it("v1Paginate returns next_cursor=null on last page", () => {
    const body = { results: [{ id: "c" }], start: 4, limit: 2, size: 5, _links: {} };
    const out = v1Paginate(body, (r) => r);
    expect(out.next_cursor).toBeNull();
    expect(out.total).toBe(5);
  });
});
