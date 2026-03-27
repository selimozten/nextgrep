import OpenAI from "openai";
import type {
  LLMConfig,
  SearchOptions,
  SearchResult,
  CodeMatch,
  AgentStep,
  ToolCall,
  ToolResult,
} from "../types.js";
import { getToolDefinitions, findTool } from "../tools/index.js";
import { getSystemPrompt } from "./prompt.js";
import { runPreSearch } from "./presearch.js";

const DEFAULT_MAX_TURNS = 3;
const DEFAULT_MAX_RESULTS = 10;
const MAX_PARALLEL_CALLS = 12;

export class SearchAgent {
  private client: OpenAI;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    const startTime = Date.now();
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const onStep = options.onStep;

    // Phase 0: Pre-search — gather file tree + grep results automatically
    onStep?.({
      turn: 0,
      type: "thinking",
      message: "Pre-searching: listing files + grepping for keywords...",
    });

    const preSearch = await runPreSearch(options.query, options.repoRoot);
    const systemPrompt = getSystemPrompt(options.repoRoot, preSearch.contextString);
    const toolDefs = getToolDefinitions();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: options.query },
    ];

    let totalToolCalls = 0;
    let steps = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      steps = turn + 1;

      onStep?.({
        turn,
        type: "thinking",
        message: `Turn ${turn + 1}/${maxTurns}: reasoning...`,
      });

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        tools: toolDefs,
        tool_choice: turn < maxTurns - 1 ? "auto" : "auto",
        temperature: this.config.temperature ?? 0.0,
        max_tokens: this.config.maxTokens ?? 4096,
      });

      const choice = response.choices[0];
      if (!choice) break;

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      // If no tool calls, the agent is done reasoning
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        onStep?.({ turn, type: "done", message: "Search complete" });
        break;
      }

      // Execute tool calls (in parallel)
      const toolCalls: ToolCall[] = assistantMessage.tool_calls
        .slice(0, MAX_PARALLEL_CALLS)
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        }));

      totalToolCalls += toolCalls.length;

      onStep?.({
        turn,
        type: "tool_calls",
        toolCalls,
        message: `Executing ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.name).join(", ")}`,
      });

      const toolResults = await this.executeToolCalls(toolCalls, options.repoRoot);

      onStep?.({
        turn,
        type: "tool_results",
        toolResults,
        message: `Got ${toolResults.length} result(s)`,
      });

      // Add tool results to messages
      for (const result of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: result.content,
        });
      }
    }

    // Extract the final answer: first try the model's JSON output,
    // then fall back to building contexts from read_file tool results
    const lastAssistantMsg = messages
      .filter((m) => m.role === "assistant")
      .pop() as OpenAI.Chat.ChatCompletionAssistantMessageParam | undefined;

    let contexts = this.parseContexts(
      lastAssistantMsg?.content as string | null,
      maxResults,
    );

    // Fallback: if the model didn't produce valid JSON contexts,
    // build them from the read_file and grep tool results
    if (contexts.length === 0 && totalToolCalls > 0) {
      contexts = this.buildContextsFromToolResults(messages, maxResults);
    }

    return {
      success: contexts.length > 0,
      query: options.query,
      contexts,
      steps,
      totalToolCalls,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Build contexts directly from tool call results when the model
   * doesn't produce valid JSON output (common with small local models).
   */
  private buildContextsFromToolResults(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    maxResults: number,
  ): CodeMatch[] {
    const contexts: CodeMatch[] = [];
    const seenFiles = new Set<string>();

    // Collect all tool calls and their results
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      const assistantMsg = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      const toolCalls = (assistantMsg as any).tool_calls;
      if (!toolCalls) continue;

      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        // Find the corresponding tool result
        const resultMsg = messages.find(
          (m) => m.role === "tool" && (m as any).tool_call_id === tc.id,
        ) as { content: string } | undefined;

        if (!resultMsg?.content) continue;
        const content = resultMsg.content;

        if (toolName === "read_file" && content && !content.startsWith("Error:")) {
          // Extract file path from the read_file args or the content header
          let filePath = "";
          try {
            const args = JSON.parse(tc.function.arguments);
            filePath = args.path || "";
          } catch {}

          // Also try to extract from the content header "// path/to/file (lines ...)"
          if (!filePath) {
            const headerMatch = content.match(/^\/\/\s+(\S+)/);
            if (headerMatch) filePath = headerMatch[1];
          }

          if (filePath && !seenFiles.has(filePath)) {
            seenFiles.add(filePath);
            // Extract line range from content header
            const lineMatch = content.match(/lines (\d+)-(\d+)/);
            contexts.push({
              file: filePath,
              content: content.split("\n").slice(1).join("\n").trim(), // Remove header line
              startLine: lineMatch ? parseInt(lineMatch[1]) : undefined,
              endLine: lineMatch ? parseInt(lineMatch[2]) : undefined,
            });
          }
        } else if (toolName === "grep" && content && content !== "No matches found.") {
          // Extract unique files from grep results
          const fileMatches = content.match(/^([^:\s]+\.\w+):\d+:/gm);
          if (fileMatches) {
            const grepFiles = [...new Set(fileMatches.map((m) => m.split(":")[0]))];
            for (const gf of grepFiles) {
              if (!seenFiles.has(gf) && contexts.length < maxResults) {
                seenFiles.add(gf);
                // Get the lines for this file from grep output
                const fileLines = content
                  .split("\n")
                  .filter((l) => l.startsWith(`${gf}:`))
                  .map((l) => l.replace(`${gf}:`, ""))
                  .join("\n");
                contexts.push({
                  file: gf,
                  content: fileLines,
                });
              }
            }
          }
        }
      }
    }

    return contexts.slice(0, maxResults);
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    repoRoot: string,
  ): Promise<ToolResult[]> {
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const tool = findTool(tc.name);
        if (!tool) {
          return {
            toolCallId: tc.id,
            content: `Error: unknown tool "${tc.name}"`,
            isError: true,
          };
        }

        try {
          const content = await tool.execute(tc.arguments, repoRoot);
          return { toolCallId: tc.id, content };
        } catch (err) {
          return {
            toolCallId: tc.id,
            content: `Error executing ${tc.name}: ${(err as Error).message}`,
            isError: true,
          };
        }
      }),
    );

    return results;
  }

  private parseContexts(content: string | null, maxResults: number): CodeMatch[] {
    if (!content) return [];

    // Try to extract JSON from the response
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : content;

    try {
      const parsed = JSON.parse(jsonStr.trim());
      const contexts = parsed.contexts || parsed;
      if (!Array.isArray(contexts)) return [];

      return contexts.slice(0, maxResults).map((ctx: Record<string, unknown>) => ({
        file: String(ctx.file || ctx.path || ""),
        content: String(ctx.content || ctx.code || ""),
        startLine: ctx.startLine as number | undefined,
        endLine: ctx.endLine as number | undefined,
        score: ctx.score as number | undefined,
      }));
    } catch {
      // If JSON parsing fails, try to extract file references from the text
      return this.extractContextsFromText(content, maxResults);
    }
  }

  private extractContextsFromText(content: string, maxResults: number): CodeMatch[] {
    const contexts: CodeMatch[] = [];
    // Match patterns like "file.ts:10-25" followed by code blocks
    const pattern = /(?:^|\n)(?:(?:File|In|See|Found in):?\s*)?[`"]?([^\s`"]+\.\w+)[`"]?(?::(\d+)(?:-(\d+))?)?[\s\S]*?```[\w]*\n([\s\S]*?)```/g;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null && contexts.length < maxResults) {
      contexts.push({
        file: match[1],
        content: match[4].trim(),
        startLine: match[2] ? parseInt(match[2]) : undefined,
        endLine: match[3] ? parseInt(match[3]) : undefined,
      });
    }

    return contexts;
  }
}
