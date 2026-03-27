#!/usr/bin/env node

/**
 * Claude Code SessionEnd hook.
 * Cleans up any NextGrep processes for this session.
 */

import { readFileSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionId = process.env.CLAUDE_SESSION_ID || "default";
const pidDir = join(tmpdir(), "nextgrep");
const pidFile = join(pidDir, `mcp-${sessionId}.pid`);

try {
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited
    }
  }
  unlinkSync(pidFile);
} catch {
  // No PID file — nothing to clean up
}

process.stdout.write(JSON.stringify({ result: "NextGrep session cleaned up." }));
