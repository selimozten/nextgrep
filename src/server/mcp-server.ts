import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SearchAgent } from "../agent/search-agent.js";
import type { LLMConfig } from "../types.js";

export async function startMcpServer(llmConfig: LLMConfig): Promise<void> {
  const agent = new SearchAgent(llmConfig);

  const server = new Server(
    { name: "nextgrep", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "nextgrep_search",
        description:
          "Search a codebase using AI-powered agentic search. The agent uses multi-turn reasoning with parallel grep and file-read operations to find relevant code sections. Returns matched code with file paths and line numbers.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Natural language search query describing what code to find",
            },
            repoRoot: {
              type: "string",
              description: "Absolute path to the repository root directory",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of code sections to return (default: 10)",
            },
            maxTurns: {
              type: "number",
              description:
                "Maximum number of agent reasoning turns (default: 3). More turns = more thorough but slower.",
            },
          },
          required: ["query", "repoRoot"],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "nextgrep_search") {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const args = request.params.arguments as Record<string, unknown>;
    const query = args.query as string;
    const repoRoot = args.repoRoot as string;
    const maxResults = (args.maxResults as number) || 10;
    const maxTurns = (args.maxTurns as number) || 3;

    if (!query || !repoRoot) {
      return {
        content: [{ type: "text", text: "Error: query and repoRoot are required" }],
        isError: true,
      };
    }

    try {
      const result = await agent.search({
        query,
        repoRoot,
        maxResults,
        maxTurns,
      });

      // Format output for the calling agent
      let output = "";
      if (!result.success) {
        output = "No relevant code found for the given query.";
      } else {
        output = result.contexts
          .map((ctx, i) => {
            let header = `[${i + 1}] ${ctx.file}`;
            if (ctx.startLine) header += `:${ctx.startLine}-${ctx.endLine}`;
            return `${header}\n${ctx.content}`;
          })
          .join("\n\n---\n\n");
      }

      output += `\n\n(${result.steps} steps, ${result.totalToolCalls} tool calls, ${result.durationMs}ms)`;

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Search failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // All logs go to stderr (stdout is reserved for MCP protocol)
  process.stderr.write("NextGrep MCP server started\n");
}
