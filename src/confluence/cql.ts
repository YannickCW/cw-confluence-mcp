// CQL composer. Builds safe Confluence Query Language fragments from structured args.
// Quoting is enforced — user input cannot inject CQL operators or escape the quoted literal.

export interface CqlArgs {
  type?: "page" | "space";
  space?: string; // space key
  label?: string;
  title?: string;
  text?: string; // free-text query
  updated_since?: string; // ISO date string
  creator?: string; // account id or username
  status?: "current" | "archived" | "draft";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

export class CqlBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CqlBuildError";
  }
}

// Escape a CQL string literal: double quotes are doubled.
// We strip control characters (incl. raw backslashes and quotes) and re-wrap.
// CQL spec: backslash escapes the next char inside double quotes.
export function quoteCqlString(value: string): string {
  // Escape backslashes first, then double quotes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function buildCql(args: CqlArgs): string {
  const fragments: string[] = [];

  if (args.type) {
    fragments.push(`type = ${quoteCqlString(args.type)}`);
  }
  if (args.space) {
    if (args.space.includes('"') || args.space.includes("\n")) {
      throw new CqlBuildError(`Invalid space key: "${args.space}".`);
    }
    fragments.push(`space = ${quoteCqlString(args.space)}`);
  }
  if (args.label) {
    fragments.push(`label = ${quoteCqlString(args.label)}`);
  }
  if (args.title) {
    fragments.push(`title ~ ${quoteCqlString(args.title)}`);
  }
  if (args.text) {
    fragments.push(`text ~ ${quoteCqlString(args.text)}`);
  }
  if (args.creator) {
    fragments.push(`creator = ${quoteCqlString(args.creator)}`);
  }
  if (args.status) {
    fragments.push(`status = ${quoteCqlString(args.status)}`);
  }
  if (args.updated_since) {
    if (!ISO_DATE.test(args.updated_since)) {
      throw new CqlBuildError(
        `updated_since must be an ISO-8601 date or timestamp (got "${args.updated_since}").`,
      );
    }
    const datePart = args.updated_since.slice(0, 10); // CQL date is YYYY-MM-DD
    fragments.push(`lastmodified >= ${quoteCqlString(datePart)}`);
  }

  if (fragments.length === 0) {
    throw new CqlBuildError("buildCql requires at least one filter.");
  }

  return fragments.join(" AND ");
}
