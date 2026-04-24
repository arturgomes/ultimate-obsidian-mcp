import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ObsidianClient } from "./client.js";
import { TOOLS, handleTool } from "./tools.js";

const apiKey = process.env.OBSIDIAN_API_KEY;
const baseUrl = process.env.OBSIDIAN_BASE_URL ?? "http://127.0.0.1:27123";

process.stderr.write(`[ultimate-obsidian-mcp] starting — baseUrl=${baseUrl}\n`);

if (!apiKey) {
  process.stderr.write("OBSIDIAN_API_KEY environment variable required\n");
  process.exit(1);
}

const client = new ObsidianClient(baseUrl, apiKey);

const server = new Server(
  { name: "ultimate-obsidian-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return { content: await handleTool(name, args ?? {}, client) };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
