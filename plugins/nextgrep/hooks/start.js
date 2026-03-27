#!/usr/bin/env node

/**
 * Claude Code SessionStart hook.
 * Registers the NextGrep MCP server so Claude can use it as a search subagent.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionId = process.env.CLAUDE_SESSION_ID || "default";
const pidDir = join(tmpdir(), "nextgrep");
const pidFile = join(pidDir, `mcp-${sessionId}.pid`);
const logFile = join(pidDir, `mcp-${sessionId}.log`);

try {
  mkdirSync(pidDir, { recursive: true });

  // The MCP server is started via stdio by Claude Code directly.
  // This hook just outputs the instruction to use nextgrep.

  const response = {
    result: "NextGrep search agent is available.",
    instructions: [
      "NextGrep is an AI-powered agentic code search tool available as an MCP tool.",
      "When the user asks to search or find code, use the nextgrep_search MCP tool.",
      "It uses multi-turn LLM reasoning with parallel grep and file-read operations.",
      "Pass the query as natural language and repoRoot as the absolute path to the repo.",
    ].join(" "),
  };

  process.stdout.write(JSON.stringify(response));
} catch (err) {
  process.stdout.write(
    JSON.stringify({ result: "NextGrep hook warning: " + err.message }),
  );
}
