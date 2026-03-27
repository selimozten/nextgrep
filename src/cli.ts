#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { SearchAgent } from "./agent/search-agent.js";
import { startServer } from "./server/http.js";
import { startMcpServer } from "./server/mcp-server.js";
import { installClaudeCode, uninstallClaudeCode } from "./integrations/claude-code.js";
import { installCodex, uninstallCodex } from "./integrations/codex.js";
import { installGenericMcp, uninstallGenericMcp } from "./integrations/generic-mcp.js";
import { startLlamaServer, RECOMMENDED_MODELS, type ModelKey } from "./llm/llama-server.js";
import type { LLMConfig } from "./types.js";

function resolveLLMConfig(opts: Record<string, string>): LLMConfig {
  return {
    baseURL:
      opts.baseUrl ||
      process.env.NEXTGREP_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1",
    apiKey:
      opts.apiKey ||
      process.env.NEXTGREP_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
    model:
      opts.model ||
      process.env.NEXTGREP_MODEL ||
      "gpt-4o-mini",
    temperature: opts.temperature ? parseFloat(opts.temperature) : 0.0,
    maxTokens: opts.maxTokens ? parseInt(opts.maxTokens) : 4096,
  };
}

const program = new Command();

program
  .name("nextgrep")
  .description(
    "Open-source agentic code search. An LLM-powered subagent that finds code using parallel grep and file-read operations.",
  )
  .version("0.1.0");

// Search command (default)
program
  .command("search", { isDefault: true })
  .description("Search a codebase with a natural language query")
  .argument("<query>", "Natural language search query")
  .option("-r, --repo <path>", "Repository root path", process.cwd())
  .option("-m, --max-results <n>", "Max results to return", "10")
  .option("-t, --max-turns <n>", "Max agent turns", "3")
  .option("--model <model>", "LLM model to use")
  .option("--api-key <key>", "API key")
  .option("--base-url <url>", "OpenAI-compatible API base URL")
  .option("--temperature <temp>", "LLM temperature")
  .option("--max-tokens <n>", "Max response tokens")
  .option("--json", "Output raw JSON")
  .option("-v, --verbose", "Show intermediate search steps")
  .action(async (query: string, opts) => {
    const llmConfig = resolveLLMConfig(opts);

    if (!llmConfig.apiKey) {
      console.error(
        chalk.red("Error: API key required. Set OPENAI_API_KEY or use --api-key"),
      );
      process.exit(1);
    }

    const agent = new SearchAgent(llmConfig);
    const spinner = ora({ text: "Searching...", color: "cyan" }).start();

    try {
      const result = await agent.search({
        query,
        repoRoot: opts.repo,
        maxResults: parseInt(opts.maxResults),
        maxTurns: parseInt(opts.maxTurns),
        onStep: (step) => {
          if (opts.verbose) {
            spinner.text = step.message || "";
          }
        },
      });

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Pretty print
      if (!result.success) {
        console.log(chalk.yellow("No relevant code found."));
        console.log(
          chalk.dim(
            `(${result.steps} steps, ${result.totalToolCalls} tool calls, ${result.durationMs}ms)`,
          ),
        );
        return;
      }

      console.log(
        chalk.green(`Found ${result.contexts.length} result(s)`) +
          chalk.dim(
            ` (${result.steps} steps, ${result.totalToolCalls} tool calls, ${result.durationMs}ms)`,
          ),
      );
      console.log();

      for (const [i, ctx] of result.contexts.entries()) {
        console.log(
          chalk.bold.cyan(`[${i + 1}] ${ctx.file}`) +
            (ctx.startLine ? chalk.dim(`:${ctx.startLine}-${ctx.endLine}`) : ""),
        );
        console.log(chalk.dim("─".repeat(60)));

        // Syntax-highlight-ish: dim line numbers
        const lines = ctx.content.split("\n");
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        console.log();
      }
    } catch (err) {
      spinner.fail(`Search failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Server command
program
  .command("serve")
  .description("Start the NextGrep HTTP API server")
  .option("-p, --port <port>", "Port to listen on", "4747")
  .option("--model <model>", "LLM model to use")
  .option("--api-key <key>", "API key")
  .option("--base-url <url>", "OpenAI-compatible API base URL")
  .action(async (opts) => {
    const llmConfig = resolveLLMConfig(opts);

    if (!llmConfig.apiKey) {
      console.error(
        chalk.red("Error: API key required. Set OPENAI_API_KEY or use --api-key"),
      );
      process.exit(1);
    }

    await startServer({
      port: parseInt(opts.port),
      llm: llmConfig,
    });
  });

// MCP command
program
  .command("mcp")
  .description("Start as an MCP (Model Context Protocol) server for AI agents")
  .option("--model <model>", "LLM model to use")
  .option("--api-key <key>", "API key")
  .option("--base-url <url>", "OpenAI-compatible API base URL")
  .action(async (opts) => {
    const llmConfig = resolveLLMConfig(opts);

    if (!llmConfig.apiKey) {
      process.stderr.write(
        "Error: API key required. Set OPENAI_API_KEY or use --api-key\n",
      );
      process.exit(1);
    }

    await startMcpServer(llmConfig);
  });

// Local mode — zero-config with llama.cpp
program
  .command("local")
  .description(
    "Search using a local LLM via llama.cpp (no API key needed). " +
    "Auto-downloads a small code search model on first run.",
  )
  .argument("<query>", "Natural language search query")
  .option("-r, --repo <path>", "Repository root path", process.cwd())
  .option("-m, --max-results <n>", "Max results to return", "10")
  .option("-t, --max-turns <n>", "Max agent turns", "3")
  .option(
    "--model <model>",
    "Model: qwen3.5-2b (default), qwen3.5-2b-reasoning, qwen2.5-coder-3b, qwen2.5-coder-7b, or .gguf path",
    "qwen3.5-2b",
  )
  .option("--port <port>", "llama-server port", "8787")
  .option("--gpu-layers <n>", "GPU layers to offload (-1=all, 0=CPU only)", "-1")
  .option("--json", "Output raw JSON")
  .option("-v, --verbose", "Show intermediate search steps")
  .action(async (query: string, opts) => {
    const spinner = ora({ color: "cyan" });

    // Start llama.cpp server
    let server;
    try {
      spinner.start("Preparing local LLM...");
      server = await startLlamaServer(
        {
          model: opts.model,
          port: parseInt(opts.port),
          nGpuLayers: parseInt(opts.gpuLayers),
        },
        (msg) => { spinner.text = msg; },
      );
      spinner.succeed("Local LLM ready");
    } catch (err) {
      spinner.fail((err as Error).message);
      process.exit(1);
    }

    // Resolve which model name to pass to the API
    const modelName = opts.model in RECOMMENDED_MODELS
      ? RECOMMENDED_MODELS[opts.model as ModelKey].name
      : opts.model;

    const llmConfig: LLMConfig = {
      baseURL: server.baseURL,
      apiKey: "local",
      model: modelName,
      temperature: 0.0,
      maxTokens: 4096,
    };

    const agent = new SearchAgent(llmConfig);
    spinner.start("Searching...");

    try {
      const result = await agent.search({
        query,
        repoRoot: opts.repo,
        maxResults: parseInt(opts.maxResults),
        maxTurns: parseInt(opts.maxTurns),
        onStep: (step) => {
          if (opts.verbose) spinner.text = step.message || "";
        },
      });

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!result.success) {
        console.log(chalk.yellow("No relevant code found."));
        console.log(
          chalk.dim(`(${result.steps} steps, ${result.totalToolCalls} tool calls, ${result.durationMs}ms)`),
        );
      } else {
        console.log(
          chalk.green(`Found ${result.contexts.length} result(s)`) +
          chalk.dim(` (${result.steps} steps, ${result.totalToolCalls} tool calls, ${result.durationMs}ms)`),
        );
        console.log();
        for (const [i, ctx] of result.contexts.entries()) {
          console.log(
            chalk.bold.cyan(`[${i + 1}] ${ctx.file}`) +
            (ctx.startLine ? chalk.dim(`:${ctx.startLine}-${ctx.endLine}`) : ""),
          );
          console.log(chalk.dim("─".repeat(60)));
          for (const line of ctx.content.split("\n")) {
            console.log(`  ${line}`);
          }
          console.log();
        }
      }
    } catch (err) {
      spinner.fail(`Search failed: ${(err as Error).message}`);
    } finally {
      server.stop();
    }
  });

// List/download models
program
  .command("models")
  .description("List available local models or download one")
  .option("-d, --download <model>", "Download a model (qwen2.5-coder-1.5b, 3b, or 7b)")
  .action(async (opts) => {
    if (opts.download) {
      const key = opts.download as ModelKey;
      if (!(key in RECOMMENDED_MODELS)) {
        console.error(chalk.red(`Unknown model: ${key}`));
        console.error(`Available: ${Object.keys(RECOMMENDED_MODELS).join(", ")}`);
        process.exit(1);
      }

      const info = RECOMMENDED_MODELS[key];
      const spinner = ora(`Downloading ${info.name}...`).start();

      try {
        spinner.text = `Downloading ${info.name}...`;
        const server = await startLlamaServer(
          { model: key, port: 18787 },
          (msg) => { spinner.text = msg; },
        );
        server.stop();
        spinner.succeed(`${info.name} downloaded and ready!`);
      } catch (err) {
        // If llama-server is not installed, the download still happened
        if ((err as Error).message.includes("llama-server not found")) {
          spinner.succeed(`${info.name} downloaded! (install llama.cpp to use it)`);
        } else {
          spinner.fail(`Download failed: ${(err as Error).message}`);
          process.exit(1);
        }
      }
      return;
    }

    // List models
    console.log(chalk.bold("\nAvailable models for local search:\n"));
    for (const [key, info] of Object.entries(RECOMMENDED_MODELS)) {
      console.log(`  ${chalk.cyan(key)}`);
      console.log(`    ${info.description}`);
      console.log();
    }
    console.log(chalk.dim("  Download: nextgrep models --download qwen2.5-coder-3b"));
    console.log(chalk.dim("  Use:      nextgrep local \"your query\" --model qwen2.5-coder-3b\n"));
  });

// Install commands
const install = program
  .command("install")
  .description("Install NextGrep for a coding agent");

install
  .command("claude-code")
  .description("Install for Claude Code (MCP server + plugin with hooks & skill)")
  .action(async () => {
    await installClaudeCode();
  });

install
  .command("codex")
  .description("Install for OpenAI Codex CLI (MCP server via .mcp.json)")
  .action(async () => {
    await installCodex();
  });

install
  .command("cursor")
  .description("Install for Cursor (MCP server via .mcp.json)")
  .action(async () => {
    await installGenericMcp("Cursor");
  });

install
  .command("windsurf")
  .description("Install for Windsurf (MCP server via .mcp.json)")
  .action(async () => {
    await installGenericMcp("Windsurf");
  });

install
  .command("gemini")
  .description("Install for Gemini CLI (MCP server via .mcp.json)")
  .action(async () => {
    await installGenericMcp("Gemini CLI");
  });

// Uninstall commands
const uninstall = program
  .command("uninstall")
  .description("Uninstall NextGrep from a coding agent");

uninstall
  .command("claude-code")
  .description("Uninstall from Claude Code")
  .action(async () => {
    await uninstallClaudeCode();
  });

uninstall
  .command("codex")
  .description("Uninstall from Codex")
  .action(async () => {
    await uninstallCodex();
  });

uninstall
  .command("cursor")
  .description("Uninstall from Cursor")
  .action(async () => {
    await uninstallGenericMcp("Cursor");
  });

uninstall
  .command("windsurf")
  .description("Uninstall from Windsurf")
  .action(async () => {
    await uninstallGenericMcp("Windsurf");
  });

uninstall
  .command("gemini")
  .description("Uninstall from Gemini CLI")
  .action(async () => {
    await uninstallGenericMcp("Gemini CLI");
  });

program.parse();
