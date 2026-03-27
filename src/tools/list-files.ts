import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "../types.js";

const execFileAsync = promisify(execFile);

async function listWithFind(repoRoot: string, path: string, glob?: string, maxDepth?: number): Promise<string> {
  // Try using fd first, then find
  const searchPath = path === "." ? repoRoot : join(repoRoot, path);

  try {
    const args = ["--type", "f", "--color", "never", "--max-results", "200"];
    if (maxDepth) args.push("--max-depth", String(maxDepth));
    if (glob) args.push("--glob", glob);
    args.push(".", searchPath);

    const { stdout } = await execFileAsync("fd", args, {
      cwd: repoRoot,
      maxBuffer: 512 * 1024,
      timeout: 10000,
    });
    return stdout.trim();
  } catch {
    // Fall back to readdir
    return await listWithReaddir(repoRoot, searchPath, glob, maxDepth || 3, 0);
  }
}

async function listWithReaddir(
  repoRoot: string,
  dir: string,
  glob: string | undefined,
  maxDepth: number,
  currentDepth: number,
): Promise<string> {
  if (currentDepth >= maxDepth) return "";

  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".svn", ".hg", "dist", "build",
    "__pycache__", ".cache", ".next", "target", "vendor",
    ".venv", "venv", "coverage", "reference-projects",
  ]);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const subResults = await listWithReaddir(repoRoot, fullPath, glob, maxDepth, currentDepth + 1);
        if (subResults) results.push(subResults);
      } else if (entry.isFile()) {
        if (glob && !matchSimpleGlob(entry.name, glob)) continue;
        results.push(relative(repoRoot, fullPath));
      }

      if (results.length >= 200) break;
    }

    return results.join("\n");
  } catch {
    return "";
  }
}

function matchSimpleGlob(filename: string, glob: string): boolean {
  // Simple glob: *.ts, *.py, etc.
  if (glob.startsWith("*.")) {
    return filename.endsWith(glob.slice(1));
  }
  return filename.includes(glob.replace(/\*/g, ""));
}

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "List files in a directory. Use this to understand the project structure and find relevant files before reading them.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'Relative directory path within the repo (default: ".")',
      },
      glob: {
        type: "string",
        description: 'File glob pattern to filter (e.g. "*.ts", "*.py")',
      },
      max_depth: {
        type: "number",
        description: "Max directory depth to traverse (default: 3)",
      },
    },
    required: [],
  },
  execute: async (args, repoRoot) => {
    const path = (args.path as string) || ".";
    const glob = args.glob as string | undefined;
    const maxDepth = (args.max_depth as number) || 3;

    const result = await listWithFind(repoRoot, path, glob, maxDepth);
    if (!result) return "No files found.";

    const lines = result.split("\n").filter(Boolean);
    if (lines.length >= 200) {
      return `${lines.join("\n")}\n\n... (results truncated at 200 files, use glob or path to narrow)`;
    }
    return lines.join("\n");
  },
};
