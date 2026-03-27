import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../types.js";

const execFileAsync = promisify(execFile);

/** Check if ripgrep is available, fall back to grep */
async function findGrepBinary(): Promise<string> {
  try {
    await execFileAsync("rg", ["--version"]);
    return "rg";
  } catch {
    return "grep";
  }
}

let grepBinary: string | null = null;

async function getGrepBinary(): Promise<string> {
  if (!grepBinary) {
    grepBinary = await findGrepBinary();
  }
  return grepBinary;
}

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search for a pattern in files using ripgrep (rg) or grep. Returns matching lines with file paths and line numbers. Supports regex patterns. Use this to find code by pattern matching.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description:
          "Relative path within the repo to search (default: search entire repo)",
      },
      glob: {
        type: "string",
        description:
          'File glob pattern to filter files (e.g. "*.ts", "*.py")',
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive search (default: false)",
      },
      max_count: {
        type: "number",
        description: "Max matches per file (default: 10)",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines around each match (default: 2)",
      },
    },
    required: ["pattern"],
  },
  execute: async (args, repoRoot) => {
    const pattern = args.pattern as string;
    const path = (args.path as string) || ".";
    const glob = args.glob as string | undefined;
    const caseInsensitive = (args.case_insensitive as boolean) || false;
    const maxCount = (args.max_count as number) || 10;
    const contextLines = (args.context_lines as number) ?? 2;

    const bin = await getGrepBinary();
    const cmdArgs: string[] = [];

    if (bin === "rg") {
      cmdArgs.push("--no-heading", "--line-number", "--color=never");
      cmdArgs.push(`--max-count=${maxCount}`);
      if (contextLines > 0) cmdArgs.push(`-C${contextLines}`);
      if (caseInsensitive) cmdArgs.push("-i");
      if (glob) cmdArgs.push(`--glob=${glob}`);
      cmdArgs.push("--max-filesize=1M");
      // Default exclusions
      cmdArgs.push("--glob=!node_modules", "--glob=!.git", "--glob=!dist",
        "--glob=!build", "--glob=!reference-projects", "--glob=!vendor",
        "--glob=!*.lock", "--glob=!*.min.js", "--glob=!*.map");
      cmdArgs.push(pattern, path);
    } else {
      cmdArgs.push("-r", "-n", "--color=never");
      cmdArgs.push(`-m${maxCount}`);
      if (contextLines > 0) cmdArgs.push(`-C${contextLines}`);
      if (caseInsensitive) cmdArgs.push("-i");
      if (glob) cmdArgs.push(`--include=${glob}`);
      cmdArgs.push(pattern, path);
    }

    try {
      const { stdout } = await execFileAsync(bin, cmdArgs, {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024, // 1MB
        timeout: 15000,
      });

      const lines = stdout.trim().split("\n");
      if (lines.length > 200) {
        return `${lines.slice(0, 200).join("\n")}\n\n... (${lines.length - 200} more lines truncated)`;
      }
      return stdout.trim() || "No matches found.";
    } catch (err: unknown) {
      const error = err as { code?: number; stdout?: string; stderr?: string };
      // Exit code 1 means no matches (ripgrep and grep)
      if (error.code === 1) return "No matches found.";
      return `Error: ${error.stderr || "grep failed"}`;
    }
  },
};
