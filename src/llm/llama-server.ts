import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

const MODELS_DIR = join(homedir(), ".nextgrep", "models");
const DEFAULT_PORT = 8787;

/** Known models that work well for code search */
export const RECOMMENDED_MODELS = {
  /** DEFAULT: Qwen3.5-2B — latest Qwen with strong reasoning and tool use. ~1.3GB */
  "qwen3.5-2b": {
    name: "Qwen3.5-2B",
    url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
    filename: "qwen3.5-2b-q4_k_m.gguf",
    contextSize: 16384,
    description: "2B params, latest Qwen 3.5, great reasoning + tool use (~1.3GB RAM) [DEFAULT]",
  },
  /** Qwen3.5-2B with Claude Opus reasoning distilled in. ~1.3GB */
  "qwen3.5-2b-reasoning": {
    name: "Qwen3.5-2B-Claude-4.6-Opus-Reasoning-Distilled",
    url: "https://huggingface.co/Jackrong/Qwen3.5-2B-Claude-4.6-Opus-Reasoning-Distilled-GGUF/resolve/main/Qwen3.5-2B.Q4_K_M.gguf",
    filename: "qwen3.5-2b-reasoning-q4_k_m.gguf",
    contextSize: 16384,
    description: "2B params, Claude Opus reasoning distilled, structured thinking (~1.3GB RAM)",
  },
  /** Code-specialized Qwen. ~2GB Q4_K_M */
  "qwen2.5-coder-3b": {
    name: "Qwen2.5-Coder-3B-Instruct",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf",
    filename: "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
    contextSize: 8192,
    description: "3B params, code-specialized, solid tool calling (~2GB RAM)",
  },
  /** Highest quality, needs more RAM. ~5GB Q4_K_M */
  "qwen2.5-coder-7b": {
    name: "Qwen2.5-Coder-7B-Instruct",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    filename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    contextSize: 8192,
    description: "7B params, best quality, slower (~5GB RAM)",
  },
} as const;

export type ModelKey = keyof typeof RECOMMENDED_MODELS;

export interface LlamaServerOptions {
  /** Model key from RECOMMENDED_MODELS or path to a .gguf file */
  model: ModelKey | string;
  /** Port for the server (default: 8787) */
  port?: number;
  /** Number of GPU layers to offload (-1 = all, 0 = CPU only) */
  nGpuLayers?: number;
  /** Context window size */
  contextSize?: number;
  /** Number of parallel request slots */
  parallel?: number;
}

/** Find llama-server binary */
async function findLlamaServer(): Promise<string | null> {
  const names = ["llama-server", "llama-cpp-server", "server"];
  for (const name of names) {
    try {
      await execFileAsync("which", [name]);
      return name;
    } catch {
      continue;
    }
  }

  // Check common install locations
  const paths = [
    "/usr/local/bin/llama-server",
    "/opt/homebrew/bin/llama-server",
    join(homedir(), "llama.cpp", "build", "bin", "llama-server"),
    join(homedir(), "llama.cpp", "llama-server"),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  return null;
}

/** Download a model from HuggingFace */
async function downloadModel(
  url: string,
  filename: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  mkdirSync(MODELS_DIR, { recursive: true });
  const destPath = join(MODELS_DIR, filename);

  if (existsSync(destPath)) {
    onProgress?.(100);
    return destPath;
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);

  const totalBytes = parseInt(response.headers.get("content-length") || "0");
  let downloadedBytes = 0;

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const fileStream = createWriteStream(destPath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      downloadedBytes += value.byteLength;
      if (totalBytes > 0) {
        onProgress?.(Math.round((downloadedBytes / totalBytes) * 100));
      }
    }
  } finally {
    fileStream.end();
  }

  return destPath;
}

/** Check if llama-server is already running on a port */
async function isServerRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for llama-server to become healthy */
async function waitForServer(port: number, timeoutMs: number = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server did not start within ${timeoutMs / 1000}s`);
}

export interface ManagedServer {
  /** The URL to use as baseURL for OpenAI-compatible API */
  baseURL: string;
  /** Stop the server */
  stop: () => void;
  /** The child process (null if server was already running) */
  process: ChildProcess | null;
}

/**
 * Start a llama.cpp server with the specified model.
 * Downloads the model if needed. Reuses an existing server if one is running.
 */
export async function startLlamaServer(
  options: LlamaServerOptions,
  onStatus?: (msg: string) => void,
): Promise<ManagedServer> {
  const port = options.port ?? DEFAULT_PORT;

  // Check if already running
  if (await isServerRunning(port)) {
    onStatus?.("llama-server already running, reusing...");
    return {
      baseURL: `http://127.0.0.1:${port}/v1`,
      stop: () => {},
      process: null,
    };
  }

  // Find llama-server binary
  const binary = await findLlamaServer();
  if (!binary) {
    throw new Error(
      "llama-server not found. Install llama.cpp:\n" +
        "  macOS: brew install llama.cpp\n" +
        "  Linux: see https://github.com/ggerganov/llama.cpp#build\n" +
        "  Or download from: https://github.com/ggerganov/llama.cpp/releases",
    );
  }
  onStatus?.(`Found llama-server: ${binary}`);

  // Resolve model path
  let modelPath: string;
  if (options.model in RECOMMENDED_MODELS) {
    const modelInfo = RECOMMENDED_MODELS[options.model as ModelKey];
    onStatus?.(`Model: ${modelInfo.name} (${modelInfo.description})`);

    const existingPath = join(MODELS_DIR, modelInfo.filename);
    if (existsSync(existingPath)) {
      modelPath = existingPath;
      onStatus?.("Model already downloaded.");
    } else {
      onStatus?.("Downloading model (this is a one-time download)...");
      modelPath = await downloadModel(modelInfo.url, modelInfo.filename, (pct) => {
        onStatus?.(`Downloading... ${pct}%`);
      });
      onStatus?.("Download complete.");
    }
  } else {
    // Assume it's a path to a .gguf file
    modelPath = options.model;
    if (!existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`);
    }
  }

  // Start llama-server
  onStatus?.("Starting llama-server...");
  const contextSize = options.contextSize ?? 8192;
  const nGpuLayers = options.nGpuLayers ?? -1; // All layers on GPU by default
  const parallel = options.parallel ?? 1;

  const args = [
    "--model", modelPath,
    "--port", String(port),
    "--ctx-size", String(contextSize),
    "--n-gpu-layers", String(nGpuLayers),
    "--parallel", String(parallel),
    "--host", "127.0.0.1",
    "--jinja",                // Use model's native Jinja template (supports tool calling)
  ];

  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Log stderr for debugging
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line.includes("error") || line.includes("Error")) {
      onStatus?.(`llama-server: ${line}`);
    }
  });

  child.on("error", (err) => {
    throw new Error(`Failed to start llama-server: ${err.message}`);
  });

  // Wait for it to be healthy
  onStatus?.("Waiting for llama-server to load model...");
  await waitForServer(port, 120000); // Models can take a while to load
  onStatus?.(`llama-server ready on port ${port}`);

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    stop: () => {
      child.kill("SIGTERM");
    },
    process: child,
  };
}

/** Get the model path for a known model (for training export target) */
export function getModelPath(model: ModelKey): string {
  const info = RECOMMENDED_MODELS[model];
  return join(MODELS_DIR, info.filename);
}

/** Get the models directory */
export function getModelsDir(): string {
  return MODELS_DIR;
}
