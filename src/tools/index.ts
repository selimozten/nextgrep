import type { ToolDefinition } from "../types.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./read-file.js";
import { listFilesTool } from "./list-files.js";

/** All tools available to the search agent */
export const tools: ToolDefinition[] = [grepTool, readFileTool, listFilesTool];

/** Get tool definitions formatted for the OpenAI API */
export function getToolDefinitions(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Find a tool by name */
export function findTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
