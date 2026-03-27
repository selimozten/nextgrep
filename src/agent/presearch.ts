import { findTool } from "../tools/index.js";

/**
 * Pre-search: automatically gather codebase context BEFORE the LLM runs.
 * This reduces the burden on small models by giving them real data
 * instead of asking them to figure out what to search.
 */

/** Extract grep-able keywords from a natural language query */
export function extractSearchTerms(query: string): string[] {
  const stopWords = new Set([
    "where", "is", "the", "how", "does", "what", "find", "show", "me",
    "all", "defined", "work", "used", "implemented", "a", "an", "of",
    "for", "in", "from", "to", "are", "can", "do", "this", "that",
    "with", "and", "or", "but", "not", "be", "has", "have", "i",
    "my", "code", "file", "function", "class", "method",
  ]);

  // Split query into words
  const words = query
    .toLowerCase()
    .replace(/[?.,!'"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Also split camelCase/PascalCase terms from the original query
  const camelSplits: string[] = [];
  for (const word of query.split(/\s+/)) {
    const parts = word.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
    if (parts.length > 1) {
      camelSplits.push(...parts.map((p) => p.toLowerCase()));
    }
    // Also split snake_case
    if (word.includes("_")) {
      camelSplits.push(...word.split("_").filter((p) => p.length > 2));
    }
  }

  const allTerms = [...new Set([...words, ...camelSplits])];
  return allTerms.slice(0, 5); // Max 5 search terms
}

/** Build grep patterns from search terms */
export function buildGrepPatterns(terms: string[]): string[] {
  if (terms.length === 0) return [];

  const patterns: string[] = [];

  // Pattern 1: OR of all terms (broad)
  if (terms.length > 1) {
    patterns.push(terms.join("|"));
  }

  // Pattern 2: Individual high-value terms
  for (const term of terms.slice(0, 3)) {
    // Skip very short terms
    if (term.length >= 4) {
      patterns.push(term);
    }
  }

  return [...new Set(patterns)];
}

export interface PreSearchResult {
  /** Project file listing (top-level structure) */
  fileTree: string;
  /** Grep results for each pattern */
  grepResults: Array<{ pattern: string; output: string }>;
  /** Combined context string to inject into the prompt */
  contextString: string;
}

/**
 * Run pre-search: list files + grep for query-derived patterns.
 * Returns context that gets injected into the system prompt.
 */
export async function runPreSearch(
  query: string,
  repoRoot: string,
): Promise<PreSearchResult> {
  const listFilesTool = findTool("list_files")!;
  const grepToolDef = findTool("grep")!;

  const terms = extractSearchTerms(query);
  const patterns = buildGrepPatterns(terms);

  // Run everything in parallel
  const [fileTree, ...grepOutputs] = await Promise.all([
    listFilesTool.execute({ path: ".", max_depth: 3 }, repoRoot),
    ...patterns.map((pattern) =>
      grepToolDef.execute(
        { pattern, max_count: 5, context_lines: 0 },
        repoRoot,
      ).catch(() => "No matches found."),
    ),
  ]);

  const grepResults = patterns.map((pattern, i) => ({
    pattern,
    output: grepOutputs[i],
  }));

  // Build the context string
  let contextString = `## Project Structure\n\`\`\`\n${truncate(fileTree, 2000)}\n\`\`\`\n`;

  const matchingGreps = grepResults.filter(
    (g) => g.output && g.output !== "No matches found.",
  );

  if (matchingGreps.length > 0) {
    contextString += "\n## Initial Search Results\n";
    for (const g of matchingGreps) {
      contextString += `\ngrep "${g.pattern}":\n\`\`\`\n${truncate(g.output, 1500)}\n\`\`\`\n`;
    }
  }

  return { fileTree, grepResults, contextString };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... (truncated)";
}
