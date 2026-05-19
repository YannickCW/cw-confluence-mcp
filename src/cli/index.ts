// Auth CLI entry point. The dispatcher in bin/cw-confluence-mcp.js calls runAuthCli().
// Builds a commander program with subcommands login | logout | status | test, each
// delegating to a function in ./auth.ts.
//
// runAuthCli accepts an injectable deps surface so unit tests can drive flows
// without hitting the real keychain or real network.

import { Command } from "commander";
import promptsDefault from "prompts";
import {
  deleteCredentials as realDelete,
  readCredentials as realRead,
  writeCredentials as realWrite,
  type CredentialsBlob,
} from "../auth/keychain.js";
import {
  runLogin,
  runLogout,
  runStatus,
  runTest,
  type PromptQuestion,
  type ResolvedAuthDeps,
} from "./auth.js";

export interface AuthCliDeps {
  prompts?: (questions: PromptQuestion[]) => Promise<Record<string, unknown>>;
  readCreds?: () => CredentialsBlob | null;
  writeCreds?: (b: CredentialsBlob) => void;
  deleteCreds?: () => boolean;
  fetchImpl?: typeof fetch;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  exit?: (code: number) => void;
  now?: () => Date;
}

function resolveDeps(deps?: AuthCliDeps): ResolvedAuthDeps & { exit: (code: number) => void } {
  const promptsImpl =
    deps?.prompts ??
    ((questions: PromptQuestion[]) =>
      promptsDefault(questions as unknown as Parameters<typeof promptsDefault>[0]) as Promise<
        Record<string, unknown>
      >);

  return {
    prompts: promptsImpl,
    readCreds: deps?.readCreds ?? realRead,
    writeCreds: deps?.writeCreds ?? realWrite,
    deleteCreds: deps?.deleteCreds ?? realDelete,
    fetchImpl: deps?.fetchImpl ?? fetch,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: deps?.exit ?? ((code: number) => process.exit(code)),
    now: deps?.now ?? (() => new Date()),
  };
}

export async function runAuthCli(args: string[], deps?: AuthCliDeps): Promise<void> {
  const resolved = resolveDeps(deps);

  const program = new Command();
  program
    .name("cw-confluence-mcp auth")
    .description("Manage Confluence Cloud credentials stored in the OS keychain.")
    .exitOverride();
  // Print commander's own errors/help to our injected stderr/stdout so tests can capture them.
  program.configureOutput({
    writeOut: (str) => resolved.stdout.write(str),
    writeErr: (str) => resolved.stderr.write(str),
  });

  let exitCode = 0;

  program
    .command("login")
    .description("Interactive login: site, email, and API token. Verifies before saving.")
    .action(async () => {
      exitCode = await runLogin(resolved);
    });

  program
    .command("logout")
    .description("Delete stored credentials. Idempotent.")
    .action(() => {
      exitCode = runLogout(resolved);
    });

  program
    .command("status")
    .description("Show login status. Never prints the token.")
    .action(() => {
      exitCode = runStatus(resolved);
    });

  program
    .command("test")
    .description("Verify stored credentials against Confluence.")
    .action(async () => {
      exitCode = await runTest(resolved);
    });

  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    // commander.exitOverride() throws on unknown command / missing args / explicit --help.
    // Map its CommanderError to an exit code without propagating.
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (e && (e.code === "commander.helpDisplayed" || e.code === "commander.help" || e.code === "commander.version")) {
      exitCode = 0;
    } else {
      if (e?.message) resolved.stderr.write(`${e.message}\n`);
      exitCode = typeof e?.exitCode === "number" ? e.exitCode : 1;
    }
  }

  // Defensive stdin teardown — `prompts` puts the TTY into raw mode for the
  // masked password input. On Windows + Node 24, calling `process.exit()` while
  // raw mode is still active can trip a libuv assertion
  // (`!(handle->flags & UV_HANDLE_CLOSING)`). Restore cooked mode and pause
  // stdin before exiting so libuv tears handles down in a quiescent state.
  try {
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean; isRaw?: boolean };
    if (stdin.isTTY) {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      stdin.unref();
    }
  } catch {
    // Best-effort cleanup; never let teardown errors clobber the real exit code.
  }

  resolved.exit(exitCode);
}
