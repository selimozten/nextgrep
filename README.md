# NextGrep

**Open-source agentic code search.** An LLM-powered subagent that finds code using multi-turn reasoning with parallel grep and file-read operations.

Unlike embedding-based semantic search tools, NextGrep uses an **agentic approach** — an LLM reasons about what to search, executes parallel `ripgrep` and file-read operations, refines across multiple turns, and returns clean, relevant code sections. No indexing, no embeddings, no vector databases.

## How It Works

```
Query: "where is authentication handled?"
         │
         ▼
┌─────────────────────────────┐
│   LLM Search Agent          │
│                             │
│   Turn 1: list_files .      │  ← Explore project structure
│   Turn 2: grep "auth|login" │  ← Search in parallel (up to 12 calls)
│           grep "middleware"  │
│           read_file auth.ts  │
│   Turn 3: read_file ...     │  ← Deep-dive promising files
│                             │
│   → Returns JSON contexts   │
└─────────────────────────────┘
         │
         ▼
  Relevant code sections with file paths & line numbers
```

## Quick Start

```bash
# Install
npm install -g nextgrep

# Search (uses OPENAI_API_KEY by default)
export OPENAI_API_KEY=sk-...
nextgrep "where is the database connection configured?"

# Use any OpenAI-compatible API (Ollama, Together, etc.)
nextgrep "auth middleware" --base-url http://localhost:11434/v1 --model llama3.1

# Verbose mode shows search steps
nextgrep "error handling patterns" -v
```

## CLI

```bash
nextgrep search <query> [options]

Options:
  -r, --repo <path>       Repository root (default: cwd)
  -m, --max-results <n>   Max results (default: 10)
  -t, --max-turns <n>     Max agent reasoning turns (default: 3)
  --model <model>         LLM model (default: gpt-4o-mini)
  --base-url <url>        OpenAI-compatible API URL
  --api-key <key>         API key
  --json                  Output raw JSON
  -v, --verbose           Show intermediate steps
```

## HTTP API Server

```bash
nextgrep serve --port 4747
```

```bash
# Search
curl -X POST http://localhost:4747/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "auth middleware", "repoRoot": "/path/to/repo"}'

# Streaming
curl -X POST http://localhost:4747/v1/search/stream \
  -H "Content-Type: application/json" \
  -d '{"query": "auth middleware", "repoRoot": "/path/to/repo"}'
```

## MCP Server (for AI Agents)

Works with Claude Code, Cursor, Windsurf, and any MCP-compatible agent.

```bash
# Claude Code
claude mcp add nextgrep -- npx nextgrep mcp

# Or in .mcp.json
{
  "mcpServers": {
    "nextgrep": {
      "command": "npx",
      "args": ["nextgrep", "mcp"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

## SDK (Programmatic Usage)

```typescript
import { NextGrep } from "nextgrep";

const ng = new NextGrep({
  baseURL: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
});

const result = await ng.search({
  query: "where is authentication handled?",
  repoRoot: "/path/to/repo",
});

for (const ctx of result.contexts) {
  console.log(`${ctx.file}:${ctx.startLine}-${ctx.endLine}`);
  console.log(ctx.content);
}
```

## Configuration

Environment variables:

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | API key for the LLM provider | - |
| `OPENAI_BASE_URL` | OpenAI-compatible API base URL | `https://api.openai.com/v1` |
| `NEXTGREP_MODEL` | Model to use | `gpt-4o-mini` |
| `NEXTGREP_API_KEY` | Override API key | - |
| `NEXTGREP_BASE_URL` | Override base URL | - |

## Architecture

NextGrep is fundamentally different from embedding-based search tools (osgrep, grepai, etc.):

| | NextGrep (Agentic) | Embedding-based |
|---|---|---|
| **Approach** | LLM reasons + executes tools | Vector similarity |
| **Indexing** | None required | Must index first |
| **Latency** | 2-6s (LLM reasoning) | <100ms (vector lookup) |
| **Accuracy** | High (multi-turn refinement) | Medium (embedding quality) |
| **Cost** | LLM API calls | Embedding + storage |
| **Best for** | Complex queries, unfamiliar codebases | Quick lookups, large codebases |

## Requirements

- Node.js 20+
- `ripgrep` (recommended) or `grep`
- An OpenAI-compatible API key

## License

MIT
