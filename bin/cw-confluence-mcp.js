#!/usr/bin/env node
// Dispatcher: routes between `serve` (MCP stdio server) and `auth` (CLI subcommands).
// No args, or `serve` → start MCP server. `auth <subcommand>` → run CLI.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = resolve(__dirname, "..", "dist");

function distImport(...segments) {
  return pathToFileURL(resolve(distDir, ...segments)).href;
}

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  process.stdout.write(
    [
      "cw-confluence-mcp — Confluence Cloud MCP server",
      "",
      "Usage:",
      "  cw-confluence-mcp [serve]                 Start MCP stdio server (default).",
      "  cw-confluence-mcp auth login              Interactive login (site, email, token).",
      "  cw-confluence-mcp auth logout             Delete stored credentials.",
      "  cw-confluence-mcp auth status             Show login status (no token).",
      "  cw-confluence-mcp auth test               Verify stored credentials.",
      "  cw-confluence-mcp --help                  Show this help.",
      "",
    ].join("\n"),
  );
}

async function run() {
  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (!command || command === "serve") {
    await import(distImport("index.js"));
    return;
  }

  if (command === "auth") {
    const cli = await import(distImport("cli", "index.js"));
    await cli.runAuthCli(args.slice(1));
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  process.exit(2);
}

run().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
