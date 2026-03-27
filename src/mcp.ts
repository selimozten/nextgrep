/**
 * NextGrep MCP Server entry point
 *
 * Usage with Claude Code:
 *   claude mcp add nextgrep -- npx nextgrep mcp
 *
 * Or in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "nextgrep": {
 *         "command": "npx",
 *         "args": ["nextgrep", "mcp"],
 *         "env": {
 *           "OPENAI_API_KEY": "sk-..."
 *         }
 *       }
 *     }
 *   }
 */

export { startMcpServer } from "./server/mcp-server.js";
