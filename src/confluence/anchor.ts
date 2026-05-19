// Inline-comment anchor resolver (§4.6).
// Given a Confluence storage-format XHTML string and a `text_marker` (plain-text substring),
// build a normalised text projection, locate the marker, and report success / ambiguity / miss.
//
// The resolver is pure — it does not call Confluence. The caller decides how to fold the result
// into the comment-create payload for v1/v2 endpoints.

export interface AnchorResolutionFound {
  status: "found";
  text_marker: string;
  occurrence: number; // 1-indexed
  total_matches: number;
  /** The plain-text projection used for matching — useful for callers that need exact-match payloads. */
  projection: string;
  /** Char offset (0-indexed) into `projection` where the match starts. */
  match_start: number;
  match_end: number; // exclusive
}

export interface AnchorResolutionNotFound {
  status: "not_found";
  text_marker: string;
}

export interface AnchorResolutionAmbiguous {
  status: "ambiguous";
  text_marker: string;
  count: number;
}

export type AnchorResolution =
  | AnchorResolutionFound
  | AnchorResolutionNotFound
  | AnchorResolutionAmbiguous;

// Resolve a text marker against a storage-format body.
// If `occurrence` is provided, the Nth match (1-indexed) is selected even if multiple exist.
export function resolveAnchor(
  bodyStorage: string,
  textMarker: string,
  occurrence?: number,
): AnchorResolution {
  if (!textMarker) {
    return { status: "not_found", text_marker: textMarker };
  }

  const projection = projectStorageToText(bodyStorage);
  const matches = findAllOccurrences(projection, textMarker);

  if (matches.length === 0) {
    return { status: "not_found", text_marker: textMarker };
  }

  if (matches.length === 1) {
    const m = matches[0]!;
    return {
      status: "found",
      text_marker: textMarker,
      occurrence: 1,
      total_matches: 1,
      projection,
      match_start: m,
      match_end: m + textMarker.length,
    };
  }

  if (occurrence === undefined) {
    return { status: "ambiguous", text_marker: textMarker, count: matches.length };
  }

  if (occurrence < 1 || occurrence > matches.length) {
    return { status: "ambiguous", text_marker: textMarker, count: matches.length };
  }

  const m = matches[occurrence - 1]!;
  return {
    status: "found",
    text_marker: textMarker,
    occurrence,
    total_matches: matches.length,
    projection,
    match_start: m,
    match_end: m + textMarker.length,
  };
}

// Strip XHTML tags, decode common entities, collapse whitespace to single spaces.
// Preserves text order, including text that spans element boundaries.
export function projectStorageToText(bodyStorage: string): string {
  if (!bodyStorage) return "";

  // Drop CDATA wrappers (Confluence wraps script-like content; rare in normal pages).
  let s = bodyStorage.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner);
  // Drop comments.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Strip all tags (greedy match within a single tag).
  s = s.replace(/<[^>]+>/g, " ");
  // Decode a small set of common entities. Anything else we leave in place.
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, num: string) => {
      const code = Number.parseInt(num, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
  // Collapse all whitespace (incl. newlines from removed tags) to single spaces.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  if (!needle) return positions;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + needle.length;
  }
  return positions;
}
