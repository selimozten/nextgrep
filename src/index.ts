/**
 * NextGrep - Open-source agentic code search
 *
 * SDK entry point for programmatic usage.
 *
 * @example
 * ```ts
 * import { NextGrep } from "nextgrep";
 *
 * const ng = new NextGrep({
 *   baseURL: "https://api.openai.com/v1",
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "gpt-4o-mini",
 * });
 *
 * const result = await ng.search({
 *   query: "where is authentication handled?",
 *   repoRoot: "/path/to/repo",
 * });
 *
 * console.log(result.contexts);
 * ```
 */

import { SearchAgent } from "./agent/search-agent.js";
import type {
  LLMConfig,
  SearchOptions,
  SearchResult,
  CodeMatch,
  AgentStep,
} from "./types.js";

export class NextGrep {
  private agent: SearchAgent;

  constructor(config: LLMConfig) {
    this.agent = new SearchAgent(config);
  }

  /**
   * Search a codebase using agentic AI search.
   * The agent will reason about the query, execute grep and file-read
   * operations in parallel, and return relevant code sections.
   */
  async search(options: SearchOptions): Promise<SearchResult> {
    return this.agent.search(options);
  }
}

// Re-export types
export type {
  LLMConfig,
  SearchOptions,
  SearchResult,
  CodeMatch,
  AgentStep,
};

// Re-export the agent for advanced usage
export { SearchAgent } from "./agent/search-agent.js";
