import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Generic MCP installation that works with any MCP-compatible agent:
 * Cursor, Windsurf, Cline, Gemini CLI, Roo Code, etc.
 *
 * All of these support .mcp.json in the project root.
 */
export async function installGenericMcp(agentName: string): Promise<void> {
  console.log(`Installing NextGrep for ${agentName}...\n`);

  const mcpPath = resolve(process.cwd(), ".mcp.json");
  let config: Record<string, unknown> = {};

  try {
    const existing = await readFile(mcpPath, "utf-8");
    config = JSON.parse(existing);
  } catch {
    // File doesn't exist yet
  }

  const servers = (config.mcpServers || {}) as Record<string, unknown>;
  servers.nextgrep = {
    command: "npx",
    args: ["nextgrep", "mcp"],
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "YOUR_API_KEY_HERE",
    },
  };
  config.mcpServers = servers;

  await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n");

  console.log("  ✓ Added nextgrep to .mcp.json");
  console.log(`\n✓ NextGrep installed for ${agentName}!`);
  console.log("  The nextgrep_search tool is now available as an MCP tool.");
  console.log(`\n  Configuration written to: ${mcpPath}`);
  console.log("  Make sure OPENAI_API_KEY is set in the env section.\n");
}

export async function uninstallGenericMcp(agentName: string): Promise<void> {
  console.log(`Uninstalling NextGrep from ${agentName}...\n`);

  const mcpPath = resolve(process.cwd(), ".mcp.json");

  try {
    const existing = await readFile(mcpPath, "utf-8");
    const config = JSON.parse(existing);
    const servers = config.mcpServers || {};
    delete servers.nextgrep;
    config.mcpServers = servers;
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n");
    console.log("  ✓ Removed nextgrep from .mcp.json");
  } catch {
    console.log("  ⚠ .mcp.json not found or nextgrep not configured");
  }

  console.log(`\n✓ NextGrep uninstalled from ${agentName}.\n`);
}
