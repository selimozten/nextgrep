#!/usr/bin/env python3
"""
Generate synthetic training data for the NextGrep code search model.

This script:
1. Clones popular open-source repos
2. For each repo, generates (query, tool_call_trace, expected_files) tuples
3. Uses a teacher model (GPT-4o / Claude) to generate high-quality search traces
4. Outputs JSONL files ready for SFT training

Usage:
    python generate_training_data.py --repos repos.json --output data/train.jsonl --teacher gpt-4o
"""

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path
from typing import Any

# -------------------------------------------------------------------
# Repo list: popular, well-structured repos across languages
# -------------------------------------------------------------------
DEFAULT_REPOS = [
    {"url": "https://github.com/expressjs/express", "lang": "javascript"},
    {"url": "https://github.com/pallets/flask", "lang": "python"},
    {"url": "https://github.com/gin-gonic/gin", "lang": "go"},
    {"url": "https://github.com/tokio-rs/axum", "lang": "rust"},
    {"url": "https://github.com/fastify/fastify", "lang": "javascript"},
    {"url": "https://github.com/tiangolo/fastapi", "lang": "python"},
    {"url": "https://github.com/gorilla/mux", "lang": "go"},
    {"url": "https://github.com/django/django", "lang": "python"},
    {"url": "https://github.com/rails/rails", "lang": "ruby"},
    {"url": "https://github.com/nestjs/nest", "lang": "typescript"},
    {"url": "https://github.com/spring-projects/spring-boot", "lang": "java"},
    {"url": "https://github.com/vercel/next.js", "lang": "typescript"},
    {"url": "https://github.com/vitejs/vite", "lang": "typescript"},
    {"url": "https://github.com/prisma/prisma", "lang": "typescript"},
    {"url": "https://github.com/strapi/strapi", "lang": "typescript"},
]

# -------------------------------------------------------------------
# Query templates: diverse search intents
# -------------------------------------------------------------------
QUERY_TEMPLATES = [
    # Definition queries
    "where is {concept} defined?",
    "find the {concept} implementation",
    "show me the {concept} class/function",
    # Flow queries
    "how does {concept} work?",
    "trace the {concept} flow from start to finish",
    "what happens when {concept}?",
    # Usage queries
    "how is {concept} used?",
    "find examples of {concept}",
    "show all places that call {concept}",
    # Architecture queries
    "what is the overall structure of {area}?",
    "how is {area} organized?",
    # Bug-hunting queries
    "where is {concept} validated?",
    "find error handling for {concept}",
    "where could {concept} fail?",
]

# Concepts to look for (will be populated from actual repo analysis)
CONCEPT_CATEGORIES = [
    "authentication", "routing", "middleware", "database connection",
    "error handling", "logging", "configuration", "testing",
    "caching", "rate limiting", "validation", "serialization",
    "websocket handling", "file upload", "session management",
]


def clone_repo(url: str, dest: Path) -> Path:
    """Clone a repo (shallow) if not already cloned."""
    name = url.rstrip("/").split("/")[-1]
    repo_path = dest / name
    if repo_path.exists():
        print(f"  Repo already cloned: {name}")
        return repo_path
    print(f"  Cloning {url}...")
    subprocess.run(
        ["git", "clone", "--depth", "1", url, str(repo_path)],
        capture_output=True, check=True,
    )
    return repo_path


def get_repo_structure(repo_path: Path, max_files: int = 100) -> list[str]:
    """Get a list of source files in the repo."""
    extensions = {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".rb", ".java", ".c", ".cpp", ".h"}
    files = []
    for f in repo_path.rglob("*"):
        if f.is_file() and f.suffix in extensions:
            rel = str(f.relative_to(repo_path))
            # Skip common non-source dirs
            if any(skip in rel for skip in ["node_modules", "vendor", ".git", "dist", "build", "__pycache__", "test/fixtures"]):
                continue
            files.append(rel)
    random.shuffle(files)
    return files[:max_files]


def generate_query_for_file(filepath: str, content: str) -> dict[str, Any] | None:
    """Generate a search query based on file content (heuristic, no LLM needed)."""
    # Extract function/class names from the file
    symbols = []
    for line in content.split("\n"):
        line = line.strip()
        # Python
        if line.startswith("def ") or line.startswith("class "):
            name = line.split("(")[0].split(":")[0].replace("def ", "").replace("class ", "").strip()
            if name and not name.startswith("_"):
                symbols.append(name)
        # JS/TS
        elif "function " in line or "export " in line:
            for kw in ["function ", "export function ", "export default function ", "export class ", "class "]:
                if kw in line:
                    rest = line.split(kw)[-1]
                    name = rest.split("(")[0].split("{")[0].split("<")[0].strip()
                    if name and len(name) < 50:
                        symbols.append(name)
        # Go
        elif line.startswith("func "):
            name = line.replace("func ", "").split("(")[0].strip()
            if name:
                symbols.append(name)

    if not symbols:
        return None

    symbol = random.choice(symbols)
    template = random.choice(QUERY_TEMPLATES)
    query = template.format(concept=symbol, area=filepath.split("/")[0] if "/" in filepath else symbol)

    return {
        "query": query,
        "expected_files": [filepath],
        "expected_symbols": [symbol],
    }


def build_tool_call_trace(query: str, repo_path: Path, expected_files: list[str]) -> list[dict]:
    """
    Build a realistic tool call trace that finds the expected files.
    This simulates what an ideal agent would do.
    """
    trace = []

    # Turn 1: Explore + broad grep
    # Simulate list_files
    trace.append({
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call_001",
                "type": "function",
                "function": {
                    "name": "list_files",
                    "arguments": json.dumps({"path": ".", "max_depth": 2}),
                },
            },
            {
                "id": "call_002",
                "type": "function",
                "function": {
                    "name": "grep",
                    "arguments": json.dumps({
                        "pattern": extract_search_term(query),
                        "max_count": 5,
                    }),
                },
            },
        ],
    })

    # Simulate tool results
    files = get_repo_structure(repo_path, 30)
    grep_results = simulate_grep(repo_path, extract_search_term(query), expected_files)

    trace.append({"role": "tool", "tool_call_id": "call_001", "content": "\n".join(files[:30])})
    trace.append({"role": "tool", "tool_call_id": "call_002", "content": grep_results})

    # Turn 2: Read the target files
    read_calls = []
    for i, f in enumerate(expected_files[:3]):
        call_id = f"call_1{i:02d}"
        read_calls.append({
            "id": call_id,
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": json.dumps({"path": f}),
            },
        })

    trace.append({
        "role": "assistant",
        "content": None,
        "tool_calls": read_calls,
    })

    for i, f in enumerate(expected_files[:3]):
        call_id = f"call_1{i:02d}"
        content = read_file_content(repo_path / f)
        trace.append({"role": "tool", "tool_call_id": call_id, "content": content})

    return trace


def extract_search_term(query: str) -> str:
    """Extract a grep-able term from a natural language query."""
    # Remove common question words
    stop_words = {"where", "is", "the", "how", "does", "what", "find", "show", "me", "all", "defined", "work", "used", "implemented", "a", "an", "of", "for", "in", "from", "to"}
    words = [w.strip("?.,!") for w in query.lower().split()]
    terms = [w for w in words if w not in stop_words and len(w) > 2]
    return "|".join(terms[:3]) if terms else query


def simulate_grep(repo_path: Path, pattern: str, expected_files: list[str]) -> str:
    """Run actual grep on the repo."""
    try:
        result = subprocess.run(
            ["grep", "-r", "-n", "-l", "--include=*.py", "--include=*.ts", "--include=*.js", "--include=*.go",
             "-m", "5", "-E", pattern, str(repo_path)],
            capture_output=True, text=True, timeout=10,
        )
        lines = result.stdout.strip().split("\n")[:10]
        # Make paths relative
        return "\n".join(l.replace(str(repo_path) + "/", "") for l in lines if l)
    except Exception:
        return "\n".join(expected_files)


def read_file_content(path: Path, max_lines: int = 50) -> str:
    """Read file content, truncated."""
    try:
        lines = path.read_text(errors="replace").split("\n")
        numbered = [f"{i+1}: {line}" for i, line in enumerate(lines[:max_lines])]
        result = "\n".join(numbered)
        if len(lines) > max_lines:
            result += f"\n\n... ({len(lines) - max_lines} more lines)"
        return result
    except Exception:
        return "Error: could not read file"


def build_training_example(
    query: str,
    repo_path: Path,
    expected_files: list[str],
    expected_symbols: list[str],
) -> dict[str, Any]:
    """Build a complete training example in ChatML format."""
    system_prompt = (
        "You are a code search agent. Your job is to find relevant code sections "
        "in a repository to answer the user's query. Use the provided tools (grep, "
        "read_file, list_files) to search, then return results as JSON."
    )

    trace = build_tool_call_trace(query, repo_path, expected_files)

    # Final assistant response with the JSON output
    contexts = []
    for f in expected_files:
        content = read_file_content(repo_path / f, max_lines=30)
        contexts.append({
            "file": f,
            "content": content,
            "startLine": 1,
            "endLine": 30,
        })

    final_response = json.dumps({"contexts": contexts}, indent=2)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": query},
        *trace,
        {"role": "assistant", "content": f"```json\n{final_response}\n```"},
    ]

    return {
        "messages": messages,
        "metadata": {
            "repo": str(repo_path.name),
            "expected_files": expected_files,
            "expected_symbols": expected_symbols,
            "query": query,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Generate NextGrep training data")
    parser.add_argument("--output", default="training/data/train.jsonl", help="Output JSONL file")
    parser.add_argument("--repos-dir", default="/tmp/nextgrep-training-repos", help="Where to clone repos")
    parser.add_argument("--max-per-repo", type=int, default=50, help="Max examples per repo")
    parser.add_argument("--repos", default=None, help="JSON file with custom repo list")
    args = parser.parse_args()

    repos = DEFAULT_REPOS
    if args.repos:
        with open(args.repos) as f:
            repos = json.load(f)

    repos_dir = Path(args.repos_dir)
    repos_dir.mkdir(parents=True, exist_ok=True)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    all_examples = []

    for repo_info in repos:
        url = repo_info["url"]
        print(f"\nProcessing {url}...")

        try:
            repo_path = clone_repo(url, repos_dir)
        except Exception as e:
            print(f"  Failed to clone: {e}")
            continue

        source_files = get_repo_structure(repo_path)
        print(f"  Found {len(source_files)} source files")

        count = 0
        for filepath in source_files:
            if count >= args.max_per_repo:
                break

            try:
                content = (repo_path / filepath).read_text(errors="replace")
            except Exception:
                continue

            query_info = generate_query_for_file(filepath, content)
            if not query_info:
                continue

            example = build_training_example(
                query_info["query"],
                repo_path,
                query_info["expected_files"],
                query_info["expected_symbols"],
            )
            all_examples.append(example)
            count += 1

        print(f"  Generated {count} examples")

    # Shuffle and write
    random.shuffle(all_examples)

    # Split 90/10 train/val
    split_idx = int(len(all_examples) * 0.9)
    train = all_examples[:split_idx]
    val = all_examples[split_idx:]

    with open(output_path, "w") as f:
        for ex in train:
            f.write(json.dumps(ex) + "\n")

    val_path = output_path.with_name("val.jsonl")
    with open(val_path, "w") as f:
        for ex in val:
            f.write(json.dumps(ex) + "\n")

    print(f"\n{'='*60}")
    print(f"Generated {len(train)} training examples → {output_path}")
    print(f"Generated {len(val)} validation examples → {val_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
