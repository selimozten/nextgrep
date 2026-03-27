#!/usr/bin/env python3
"""
Evaluate a NextGrep model on code search benchmarks.

Metrics:
  - F1: overlap between retrieved files and expected files
  - Steps: average number of agent turns used
  - Latency: average search time
  - Token efficiency: input + output tokens per search

Usage:
    python evaluate.py --model http://localhost:8787/v1 --data training/data/val.jsonl
"""

import argparse
import json
import time
import subprocess
import sys
from pathlib import Path
from typing import Any


def run_search(base_url: str, model: str, query: str, repo_root: str, max_turns: int = 3) -> dict[str, Any]:
    """Run a search using the NextGrep HTTP API or directly via the CLI."""
    try:
        import httpx
    except ImportError:
        # Fall back to subprocess
        result = subprocess.run(
            ["node", "dist/cli.js", "search", query,
             "--repo", repo_root, "--json",
             "--base-url", base_url,
             "--api-key", "local",
             "--model", model,
             "--max-turns", str(max_turns)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        return {"success": False, "contexts": [], "steps": 0, "totalToolCalls": 0, "durationMs": 0}

    response = httpx.post(
        f"{base_url.rstrip('/v1')}/v1/search",
        json={"query": query, "repoRoot": repo_root, "maxTurns": max_turns},
        timeout=60,
    )
    return response.json()


def compute_f1(predicted_files: set[str], expected_files: set[str]) -> dict[str, float]:
    """Compute precision, recall, and F1."""
    if not predicted_files and not expected_files:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not predicted_files or not expected_files:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}

    tp = len(predicted_files & expected_files)
    precision = tp / len(predicted_files) if predicted_files else 0
    recall = tp / len(expected_files) if expected_files else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {"precision": precision, "recall": recall, "f1": f1}


def main():
    parser = argparse.ArgumentParser(description="Evaluate NextGrep model")
    parser.add_argument("--base-url", default="http://localhost:8787/v1", help="LLM API base URL")
    parser.add_argument("--model", default="qwen2.5-coder-3b", help="Model name")
    parser.add_argument("--data", default="training/data/val.jsonl", help="Validation JSONL file")
    parser.add_argument("--repos-dir", default="/tmp/nextgrep-training-repos", help="Where repos are cloned")
    parser.add_argument("--max-examples", type=int, default=50, help="Max examples to evaluate")
    parser.add_argument("--max-turns", type=int, default=3, help="Max agent turns")
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"Validation data not found: {args.data}")
        print("Run: python training/scripts/generate_training_data.py")
        sys.exit(1)

    examples = []
    with open(data_path) as f:
        for line in f:
            ex = json.loads(line)
            examples.append(ex)
            if len(examples) >= args.max_examples:
                break

    print(f"Evaluating {len(examples)} examples...")
    print(f"Model: {args.model}")
    print(f"Base URL: {args.base_url}")
    print(f"Max turns: {args.max_turns}")
    print()

    results = []
    for i, ex in enumerate(examples):
        meta = ex.get("metadata", {})
        query = meta.get("query", "")
        expected_files = set(meta.get("expected_files", []))
        repo_name = meta.get("repo", "")
        repo_root = str(Path(args.repos_dir) / repo_name)

        if not Path(repo_root).exists():
            print(f"  [{i+1}] SKIP: repo not found: {repo_root}")
            continue

        print(f"  [{i+1}/{len(examples)}] {query[:60]}...", end=" ", flush=True)
        start = time.time()

        try:
            result = run_search(args.base_url, args.model, query, repo_root, args.max_turns)
        except Exception as e:
            print(f"ERROR: {e}")
            continue

        elapsed = time.time() - start
        predicted_files = {ctx.get("file", "") for ctx in result.get("contexts", [])}
        metrics = compute_f1(predicted_files, expected_files)

        print(f"F1={metrics['f1']:.2f} steps={result.get('steps', 0)} {elapsed:.1f}s")

        results.append({
            "query": query,
            "f1": metrics["f1"],
            "precision": metrics["precision"],
            "recall": metrics["recall"],
            "steps": result.get("steps", 0),
            "tool_calls": result.get("totalToolCalls", 0),
            "duration_ms": result.get("durationMs", 0),
            "predicted_files": list(predicted_files),
            "expected_files": list(expected_files),
        })

    if not results:
        print("\nNo results to report.")
        return

    # Aggregate
    avg_f1 = sum(r["f1"] for r in results) / len(results)
    avg_steps = sum(r["steps"] for r in results) / len(results)
    avg_tool_calls = sum(r["tool_calls"] for r in results) / len(results)
    avg_duration = sum(r["duration_ms"] for r in results) / len(results)

    print(f"\n{'='*60}")
    print(f"RESULTS ({len(results)} examples)")
    print(f"{'='*60}")
    print(f"  F1 Score:       {avg_f1:.3f}")
    print(f"  Avg Steps:      {avg_steps:.1f}")
    print(f"  Avg Tool Calls: {avg_tool_calls:.1f}")
    print(f"  Avg Latency:    {avg_duration:.0f}ms")
    print(f"{'='*60}")

    # Save detailed results
    output_path = Path("training/data/eval_results.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump({
            "summary": {
                "f1": avg_f1,
                "avg_steps": avg_steps,
                "avg_tool_calls": avg_tool_calls,
                "avg_duration_ms": avg_duration,
                "num_examples": len(results),
            },
            "results": results,
        }, f, indent=2)
    print(f"\nDetailed results saved to {output_path}")


if __name__ == "__main__":
    main()
