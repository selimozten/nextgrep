import { readFile, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { ToolDefinition } from "../types.js";

const MAX_FILE_SIZE = 512 * 1024; // 512KB
const MAX_LINES = 300;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the file content with line numbers. You can specify a line range to read a specific section.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative file path within the repo",
      },
      start_line: {
        type: "number",
        description: "Start line number (1-based, default: 1)",
      },
      end_line: {
        type: "number",
        description: "End line number (1-based, default: start_line + 300)",
      },
    },
    required: ["path"],
  },
  execute: async (args, repoRoot) => {
    const filePath = args.path as string;
    const startLine = (args.start_line as number) || 1;

    const absPath = resolve(repoRoot, filePath);
    const relPath = relative(repoRoot, absPath);

    // Security: prevent path traversal
    if (relPath.startsWith("..") || resolve(absPath) !== absPath.replace(/\/$/, "")) {
      // Re-check more carefully
      const resolved = resolve(repoRoot, filePath);
      if (!resolved.startsWith(resolve(repoRoot))) {
        return "Error: path traversal not allowed";
      }
    }

    try {
      const fileStat = await stat(absPath);
      if (fileStat.size > MAX_FILE_SIZE) {
        return `Error: file too large (${(fileStat.size / 1024).toFixed(0)}KB). Use start_line/end_line to read a section.`;
      }

      const content = await readFile(absPath, "utf-8");
      const allLines = content.split("\n");
      const start = Math.max(1, startLine);
      const endLine = (args.end_line as number) || Math.min(start + MAX_LINES - 1, allLines.length);
      const end = Math.min(endLine, allLines.length);

      const lines = allLines.slice(start - 1, end);
      const numbered = lines.map((line, i) => `${start + i}: ${line}`);

      let result = `// ${relPath} (lines ${start}-${end} of ${allLines.length})\n`;
      result += numbered.join("\n");

      if (end < allLines.length) {
        result += `\n\n... (${allLines.length - end} more lines)`;
      }

      return result;
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "ENOENT") return `Error: file not found: ${filePath}`;
      if (error.code === "EISDIR") return `Error: path is a directory: ${filePath}`;
      return `Error reading file: ${(err as Error).message}`;
    }
  },
};
