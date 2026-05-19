import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "./auth/credentials.js";
import { ConfluenceClient } from "./confluence/client.js";
import { logger } from "./shared/logger.js";
import { registerTools } from "./tools/register.js";

const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  process.stderr.write("cw-confluence-mcp starting (stdio)…\n");

  const loadResult = loadCredentials();
  if (!loadResult.ok) {
    process.stderr.write(`${loadResult.message}\n`);
    process.exit(1);
  }

  const client = new ConfluenceClient({ creds: loadResult.creds });
  logger.info(`Loaded credentials for ${loadResult.creds.email} on ${loadResult.creds.site} (source: ${loadResult.source}).`);

  const server = new Server(
    {
      name: "cw-confluence-mcp",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerTools(server, { client });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("cw-confluence-mcp ready.\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
