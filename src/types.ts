/** Configuration for the LLM provider */
export interface LLMConfig {
  /** OpenAI-compatible API base URL */
  baseURL: string;
  /** API key */
  apiKey: string;
  /** Model to use for the search agent */
  model: string;
  /** Max tokens for the response */
  maxTokens?: number;
  /** Temperature (lower = more focused search) */
  temperature?: number;
}

/** A single tool call the agent wants to execute */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of executing a tool */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/** A code match found by the search */
export interface CodeMatch {
  file: string;
  content: string;
  startLine?: number;
  endLine?: number;
  score?: number;
}

/** Final result from a search operation */
export interface SearchResult {
  success: boolean;
  query: string;
  contexts: CodeMatch[];
  steps: number;
  totalToolCalls: number;
  durationMs: number;
}

/** Options for running a search */
export interface SearchOptions {
  /** Natural language search query */
  query: string;
  /** Root directory of the repo to search */
  repoRoot: string;
  /** Max number of agent turns (default: 3) */
  maxTurns?: number;
  /** Max results to return (default: 10) */
  maxResults?: number;
  /** File patterns to include (glob) */
  include?: string[];
  /** File patterns to exclude (glob) */
  exclude?: string[];
  /** Stream intermediate steps */
  onStep?: (step: AgentStep) => void;
}

/** An intermediate step from the agent loop */
export interface AgentStep {
  turn: number;
  type: "thinking" | "tool_calls" | "tool_results" | "done";
  message?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/** Configuration for the NextGrep server */
export interface ServerConfig {
  /** Port to listen on */
  port: number;
  /** LLM configuration */
  llm: LLMConfig;
  /** CORS origins to allow */
  corsOrigins?: string[];
}

/** Tool definition for the agent */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, repoRoot: string) => Promise<string>;
}
