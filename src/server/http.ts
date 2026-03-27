import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SearchAgent } from "../agent/search-agent.js";
import type { ServerConfig, SearchOptions, SearchResult } from "../types.js";

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

export async function startServer(config: ServerConfig): Promise<void> {
  const agent = new SearchAgent(config.llm);

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      json(res, 204, null);
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${config.port}`);

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { status: "ok", version: "0.1.0" });
      return;
    }

    // Search endpoint
    if (url.pathname === "/v1/search" && req.method === "POST") {
      try {
        const body = JSON.parse(await parseBody(req));

        const { query, repoRoot, maxTurns, maxResults, include, exclude } = body;

        if (!query || !repoRoot) {
          json(res, 400, { error: "query and repoRoot are required" });
          return;
        }

        const searchOpts: SearchOptions = {
          query,
          repoRoot,
          maxTurns,
          maxResults,
          include,
          exclude,
        };

        const result = await agent.search(searchOpts);
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
      return;
    }

    // Streaming search endpoint
    if (url.pathname === "/v1/search/stream" && req.method === "POST") {
      try {
        const body = JSON.parse(await parseBody(req));
        const { query, repoRoot, maxTurns, maxResults } = body;

        if (!query || !repoRoot) {
          json(res, 400, { error: "query and repoRoot are required" });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        const result = await agent.search({
          query,
          repoRoot,
          maxTurns,
          maxResults,
          onStep: (step) => {
            res.write(`data: ${JSON.stringify(step)}\n\n`);
          },
        });

        res.write(`data: ${JSON.stringify({ type: "result", ...result })}\n\n`);
        res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: "error", message: (err as Error).message })}\n\n`);
        res.end();
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(config.port, () => {
    console.log(`NextGrep server listening on http://localhost:${config.port}`);
    console.log(`  POST /v1/search         - Run a search`);
    console.log(`  POST /v1/search/stream   - Run a search with streaming steps`);
    console.log(`  GET  /health             - Health check`);
  });

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`\nShutting down...`);
      server.close();
      process.exit(0);
    });
  }
}
