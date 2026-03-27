# NextGrep - Agentic Code Search

NextGrep is an AI-powered code search subagent. It uses multi-turn LLM reasoning with parallel grep and file-read operations to find relevant code in any codebase.

## When to Use

Use NextGrep when you need to:
- Find code related to a concept (e.g., "authentication middleware", "database connection pooling")
- Locate implementations across multiple files
- Explore an unfamiliar codebase
- Find all places where a pattern is used

## How to Use

NextGrep is available as the `nextgrep_search` MCP tool. Call it with:

- **query** (required): Natural language description of what code to find
- **repoRoot** (required): Absolute path to the repository root
- **maxResults** (optional): Maximum code sections to return (default: 10)
- **maxTurns** (optional): Agent reasoning depth 1-5 (default: 3)

## Example

```
nextgrep_search({
  query: "where is the rate limiting middleware configured?",
  repoRoot: "/Users/dev/my-project",
  maxResults: 5
})
```

## How It Works

1. The search agent receives your natural language query
2. It explores the project structure using `list_files`
3. It searches for patterns using `grep` (ripgrep) with up to 12 parallel calls
4. It reads promising files with `read_file` to get full context
5. After up to 3 reasoning turns, it returns relevant code sections with file paths and line numbers

## Tips

- Be specific in your queries for better results
- For broad exploration, increase `maxTurns` to 4 or 5
- For quick lookups, set `maxTurns` to 1 or 2
