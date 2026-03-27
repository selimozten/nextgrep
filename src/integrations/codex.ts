import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Install NextGrep for OpenAI Codex CLI.
 * Codex uses MCP servers configured in ~/.codex/config.json or .mcp.json
 */
export async function installCodex(): Promise<void> {
  console.log("Installing NextGrep for Codex...\n");

  // Codex supports .mcp.json (same format as Claude Code)
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
  console.log("\n✓ NextGrep installed for Codex!");
  console.log("  Codex will now have access to the nextgrep_search tool.");
  console.log("  Try: codex \"use nextgrep to find the auth middleware\"\n");
}

/**
 * Uninstall NextGrep from Codex.
 */
export async function uninstallCodex(): Promise<void> {
  console.log("Uninstalling NextGrep from Codex...\n");

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

  console.log("\n✓ NextGrep uninstalled from Codex.\n");
}
