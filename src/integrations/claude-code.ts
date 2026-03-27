import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // dist/integrations/ -> project root -> plugins/nextgrep
  return resolve(__dirname, "..", "..", "plugins", "nextgrep");
}

/**
 * Install NextGrep as a Claude Code plugin with MCP server.
 * This registers:
 * 1. The MCP server (for the nextgrep_search tool)
 * 2. The plugin (for session hooks and skill)
 */
export async function installClaudeCode(): Promise<void> {
  console.log("Installing NextGrep for Claude Code...\n");

  // 1. Register MCP server
  console.log("  [1/2] Registering MCP server...");
  try {
    const nextgrepBin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");
    await execFileAsync("claude", [
      "mcp", "add", "nextgrep", "--",
      "node", nextgrepBin, "mcp",
    ], { timeout: 15000 });
    console.log("    ✓ MCP server registered");
  } catch (err) {
    // Try alternative: add to .mcp.json
    console.log("    ⚠ claude CLI not found, writing .mcp.json instead...");
    await writeMcpJson();
    console.log("    ✓ .mcp.json updated");
  }

  // 2. Install plugin
  console.log("  [2/2] Installing plugin (hooks + skill)...");
  try {
    const pluginRoot = getPluginRoot();
    await execFileAsync("claude", [
      "plugin", "install", pluginRoot,
    ], { timeout: 15000 });
    console.log("    ✓ Plugin installed");
  } catch {
    console.log("    ⚠ Plugin install skipped (claude CLI not available)");
    console.log("    → The MCP server alone is sufficient for search functionality");
  }

  console.log("\n✓ NextGrep installed for Claude Code!");
  console.log("  Claude will now have access to the nextgrep_search tool.");
  console.log("  Try asking: \"use nextgrep to find where auth is handled\"\n");
}

/**
 * Uninstall NextGrep from Claude Code.
 */
export async function uninstallClaudeCode(): Promise<void> {
  console.log("Uninstalling NextGrep from Claude Code...\n");

  try {
    await execFileAsync("claude", ["mcp", "remove", "nextgrep"], { timeout: 10000 });
    console.log("  ✓ MCP server removed");
  } catch {
    console.log("  ⚠ MCP server was not registered");
  }

  try {
    await execFileAsync("claude", ["plugin", "uninstall", "nextgrep"], { timeout: 10000 });
    console.log("  ✓ Plugin uninstalled");
  } catch {
    console.log("  ⚠ Plugin was not installed");
  }

  console.log("\n✓ NextGrep uninstalled from Claude Code.\n");
}

async function writeMcpJson(): Promise<void> {
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
}
