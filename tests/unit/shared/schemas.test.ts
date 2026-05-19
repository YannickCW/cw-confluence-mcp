import { describe, expect, it } from "vitest";
import {
  CommentType,
  InlineAnchorInput,
  LabelSchema,
  PageId,
  PageStatus,
  PaginationInput,
  SpaceKey,
  SpaceStatus,
  SpaceType,
  VersionMeta,
} from "../../../src/shared/schemas.js";

describe("shared/schemas", () => {
  it("PageId rejects empty strings", () => {
    expect(PageId.safeParse("").success).toBe(false);
    expect(PageId.safeParse("12345").success).toBe(true);
  });

  it("SpaceKey accepts normal keys", () => {
    expect(SpaceKey.safeParse("DEV").success).toBe(true);
    expect(SpaceKey.safeParse("").success).toBe(false);
    expect(SpaceKey.safeParse("X".repeat(256)).success).toBe(false);
  });

  it("PaginationInput defaults pagelen=25 and accepts cursor or page", () => {
    expect(PaginationInput.parse({})).toEqual({ pagelen: 25 });
    expect(PaginationInput.parse({ cursor: "ABC" })).toEqual({ cursor: "ABC", pagelen: 25 });
    expect(PaginationInput.parse({ page: 3, pagelen: 50 })).toEqual({ page: 3, pagelen: 50 });
  });

  it("PaginationInput caps pagelen at 100", () => {
    expect(PaginationInput.safeParse({ pagelen: 101 }).success).toBe(false);
  });

  it("PageStatus / SpaceStatus / SpaceType / CommentType enums", () => {
    expect(PageStatus.safeParse("current").success).toBe(true);
    expect(PageStatus.safeParse("nope").success).toBe(false);
    expect(SpaceStatus.options).toEqual(["current", "archived"]);
    expect(SpaceType.options).toEqual(["global", "personal"]);
    expect(CommentType.options).toEqual(["footer", "inline", "both"]);
  });

  it("InlineAnchorInput requires text_marker, makes occurrence optional", () => {
    expect(InlineAnchorInput.safeParse({ text_marker: "hi" }).success).toBe(true);
    expect(InlineAnchorInput.safeParse({ text_marker: "hi", occurrence: 2 }).success).toBe(true);
    expect(InlineAnchorInput.safeParse({}).success).toBe(false);
    expect(InlineAnchorInput.safeParse({ text_marker: "hi", occurrence: 0 }).success).toBe(false);
  });

  it("LabelSchema accepts minimal label objects", () => {
    expect(LabelSchema.safeParse({ name: "runbook" }).success).toBe(true);
    expect(LabelSchema.safeParse({ name: "runbook", prefix: "global" }).success).toBe(true);
  });

  it("VersionMeta requires `number`", () => {
    expect(VersionMeta.safeParse({ number: 1 }).success).toBe(true);
    expect(VersionMeta.safeParse({}).success).toBe(false);
  });
});
