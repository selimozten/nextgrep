#!/bin/bash
# Benchmark NextGrep against its own codebase
# Measures: accuracy (did it find the right file?), latency, tool calls

REPO="/Users/selim.ozten/Desktop/folder/main/nextgrep"
CLI="node $REPO/dist/cli.js"

echo "=========================================="
echo " NextGrep Benchmark (Qwen3.5-2B Q4_K_M)"
echo "=========================================="
echo ""

# Define test cases: query | expected_file_substring
declare -a QUERIES=(
  "where is the agentic search loop implemented?|search-agent"
  "how does the grep tool work?|tools/grep"
  "find the MCP server implementation|mcp-server"
  "where are the TypeScript types defined?|types.ts"
  "how does the HTTP API server handle requests?|server/http"
  "find the system prompt for the search agent|prompt.ts"
  "where is the llama.cpp integration?|llama-server"
  "how are tool definitions registered?|tools/index"
  "find the Claude Code install integration|claude-code"
  "where is the file reading tool?|read-file"
)

PASS=0
FAIL=0
TOTAL_MS=0
TOTAL_CALLS=0
TOTAL_STEPS=0

for entry in "${QUERIES[@]}"; do
  IFS='|' read -r query expected <<< "$entry"

  # Run search
  result=$($CLI local "$query" --repo "$REPO" --max-turns 3 --json 2>/dev/null)

  # Parse result
  success=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',False))" 2>/dev/null)
  duration=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('durationMs',0))" 2>/dev/null)
  steps=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('steps',0))" 2>/dev/null)
  tool_calls=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalToolCalls',0))" 2>/dev/null)
  files=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(c.get('file','') for c in d.get('contexts',[])))" 2>/dev/null)
  num_results=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('contexts',[])))" 2>/dev/null)

  # Check if expected file was found
  if echo "$files" | grep -qi "$expected"; then
    status="PASS"
    PASS=$((PASS + 1))
  else
    status="FAIL"
    FAIL=$((FAIL + 1))
  fi

  TOTAL_MS=$((TOTAL_MS + ${duration:-0}))
  TOTAL_CALLS=$((TOTAL_CALLS + ${tool_calls:-0}))
  TOTAL_STEPS=$((TOTAL_STEPS + ${steps:-0}))

  printf "%-4s | %5dms | %d steps | %d calls | %d results | %s\n" \
    "$status" "${duration:-0}" "${steps:-0}" "${tool_calls:-0}" "${num_results:-0}" "$query"
done

echo ""
echo "=========================================="
TOTAL=${#QUERIES[@]}
echo "Results: $PASS/$TOTAL passed ($((PASS * 100 / TOTAL))% accuracy)"
echo "Avg latency: $((TOTAL_MS / TOTAL))ms"
echo "Avg steps: $(python3 -c "print(f'{$TOTAL_STEPS/$TOTAL:.1f}')")"
echo "Avg tool calls: $(python3 -c "print(f'{$TOTAL_CALLS/$TOTAL:.1f}')")"
echo "=========================================="
