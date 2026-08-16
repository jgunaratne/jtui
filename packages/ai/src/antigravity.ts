import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CatalogEntry, ModelApi, ModelCatalog } from "./catalog.ts";
import type { ModelClient } from "./engine.ts";
import type { PricingTable } from "./models.ts";
import type { AssistantMessage, Context, StreamEvent, StreamOptions, Usage } from "./types.ts";

/** Known locations of the Jetski CLI binary by platform. */
const JETSKI_PATHS: string[] =
	process.platform === "darwin"
		? ["/usr/local/bin/jetski", "/usr/local/google/jetski-cli/jetski-cli"]
		: ["/google/bin/releases/jetski-devs/tools/cli"];

/** Resolve the Jetski CLI binary, or undefined when not found. */
export function findJetskiCli(): string | undefined {
	for (const path of JETSKI_PATHS) {
		if (existsSync(path)) return path;
	}
	return undefined;
}

/** Environment stripped of Antigravity sandbox variables. */
function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("ANTIGRAVITY_")) {
			env[key] = value;
		}
	}
	return env;
}

// ---------- Jetski stream-json protocol types ----------

interface JetskiUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}

interface JetskiStepUpdate {
	conversation_id: string;
	step_index: number;
	state: string;
	step_type: string;
	text_delta?: string;
	duration_seconds?: number;
	usage?: JetskiUsage;
}

interface JetskiResult {
	conversation_id: string;
	status: string;
	response: string;
	error?: string;
	duration_seconds: number;
	num_turns: number;
	usage: JetskiUsage;
}

interface JetskiEvent {
	event: "init" | "step_update" | "result";
	step_update?: JetskiStepUpdate;
	result?: JetskiResult;
}

function toUsage(usage: JetskiUsage | undefined): Usage {
	if (!usage) return { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 };
	return {
		input: usage.input_tokens,
		output: usage.output_tokens,
		cacheRead: usage.cache_read_tokens,
		thinking: usage.thinking_tokens,
		costUsd: 0,
	};
}

// ---------- Model discovery ----------

/**
 * Discover models by asking the Jetski CLI for its model list.
 *
 * Uses a deliberate invalid model name, which causes the CLI to list all
 * available models in its error message.
 */
export async function discoverAntigravityModels(jetskiPath: string): Promise<ModelCatalog> {
	return new Promise<ModelCatalog>((resolve, reject) => {
		const child = spawn(
			jetskiPath,
			[
				"--print=list models",
				"--output-format=stream-json",
				"--model=__jtui_probe__",
				"--dangerously-skip-permissions",
				"--print-timeout=15s",
			],
			{ env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] },
		);

		let stderr = "";
		let stdout = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.on("close", () => {
			const text = stdout + stderr;
			// Parse model names from the error output.
			// Format: "Available models:\n  Model Name 1\n  Model Name 2\n ..."
			const match = /Available models:\n((?:\s+.+\n?)+)/i.exec(text);
			if (!match?.[1]) {
				reject(new Error(`Could not discover Antigravity models. Output: ${text.slice(0, 500)}`));
				return;
			}
			const names = match[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);

			const entries: CatalogEntry[] = names.map((name) => {
				const lower = name.toLowerCase();
				const publisher = lower.includes("claude") ? "anthropic" : "google";
				const api: ModelApi | undefined = publisher === "anthropic" ? "anthropic" : "gemini";
				return { id: name, publisher, api, available: true };
			});

			resolve({
				project: "antigravity",
				location: "jetski",
				fetchedAt: Date.now(),
				entries,
			});
		});

		child.on("error", reject);
	});
}

// ---------- AntigravityClient ----------

/** Error raised when the Jetski CLI is not installed. */
export class JetskiNotFoundError extends Error {
	readonly hints: string[];

	constructor() {
		super("Jetski CLI not found.");
		this.name = "JetskiNotFoundError";
		this.hints = [
			"Install it with: mule install jetski-cli (macOS) or see go/jetski-cli-getting-started",
			"Or switch to gcloud mode: jtui --engine gcloud",
		];
	}
}

/**
 * Model client that routes requests through the Jetski CLI.
 *
 * Each stream() call spawns `jetski --print --output-format=stream-json` and
 * translates the JSONL events into the same StreamEvent protocol that
 * VertexClient produces.
 */
export class AntigravityClient implements ModelClient {
	readonly jetskiPath: string;
	catalog: ModelCatalog | undefined;
	readonly pricing: PricingTable;

	constructor(jetskiPath: string, options: { catalog?: ModelCatalog; pricing?: PricingTable } = {}) {
		this.jetskiPath = jetskiPath;
		this.catalog = options.catalog;
		this.pricing = options.pricing ?? {};
	}

	entryFor(model: string): CatalogEntry | undefined {
		return this.catalog?.entries.find((entry) => entry.id === model);
	}

	resolveApi(model: string): ModelApi {
		const entry = this.entryFor(model);
		if (entry?.api) return entry.api;
		const lower = model.toLowerCase();
		if (lower.includes("claude")) return "anthropic";
		return "gemini";
	}

	async *stream(model: string, context: Context, options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
		// Build the prompt from the last user message in context.
		const lastMessage = context.messages[context.messages.length - 1];
		let prompt: string;
		if (!lastMessage) {
			yield { type: "done", message: errorMessage("No messages in context.") };
			return;
		}
		if (lastMessage.role === "user") {
			prompt =
				typeof lastMessage.content === "string"
					? lastMessage.content
					: lastMessage.content
							.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("\n");
		} else if (lastMessage.role === "toolResult") {
			// Tool results are part of a multi-turn flow; serialize the full context.
			prompt = serializeContext(context);
		} else {
			prompt = serializeContext(context);
		}

		const args = [
			`--print=${prompt}`,
			"--output-format=stream-json",
			`--model=${model}`,
			"--dangerously-skip-permissions",
			"--print-timeout=300s",
		];
		if (options.thinking && options.thinking !== "off") {
			args.push(`--effort=${options.thinking}`);
		}

		const child = spawn(this.jetskiPath, args, {
			env: cleanEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Wire up abort signal.
		if (options.signal) {
			const onAbort = () => child.kill("SIGTERM");
			options.signal.addEventListener("abort", onAbort, { once: true });
			child.on("close", () => options.signal?.removeEventListener("abort", onAbort));
		}

		yield { type: "start", model };

		let fullText = "";
		let lastUsage: Usage = { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 };
		let hadError = false;
		let errorText = "";

		const rl = createInterface({ input: child.stdout });
		for await (const line of rl) {
			if (line.trim().length === 0) continue;
			let parsed: JetskiEvent;
			try {
				parsed = JSON.parse(line) as JetskiEvent;
			} catch {
				// Non-JSON output (e.g. text mode fallback); treat as text.
				fullText += `${line}\n`;
				yield { type: "text_delta", delta: `${line}\n` };
				continue;
			}

			if (parsed.event === "step_update" && parsed.step_update) {
				const step = parsed.step_update;
				if (step.step_type === "agent_response" && step.text_delta) {
					fullText += step.text_delta;
					yield { type: "text_delta", delta: step.text_delta };
				}
				if (step.usage) lastUsage = toUsage(step.usage);
			}

			if (parsed.event === "result" && parsed.result) {
				const result = parsed.result;
				lastUsage = toUsage(result.usage);
				if (result.status === "ERROR" && result.error) {
					hadError = true;
					errorText = result.error;
				}
				// If the result has response text we haven't seen via deltas, emit it.
				if (result.response && result.response !== fullText) {
					const remaining = result.response.slice(fullText.length);
					if (remaining.length > 0) {
						fullText += remaining;
						yield { type: "text_delta", delta: remaining };
					}
				}
			}
		}

		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: fullText }],
			stopReason: hadError ? "error" : options.signal?.aborted ? "aborted" : "stop",
			usage: lastUsage,
			model,
			...(hadError ? { errorMessage: errorText } : {}),
		};
		yield { type: "done", message: finalMessage };
	}
}

function errorMessage(message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		usage: { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 },
		errorMessage: message,
	};
}

/** Flatten a multi-turn context into a single prompt string. */
function serializeContext(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`[System]: ${context.systemPrompt}`);
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("\n");
			parts.push(`[User]: ${text}`);
		} else if (msg.role === "assistant") {
			const text = msg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("");
			if (text) parts.push(`[Assistant]: ${text}`);
		} else if (msg.role === "toolResult") {
			const text = msg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			parts.push(`[Tool ${msg.toolName}]: ${text}`);
		}
	}
	return parts.join("\n\n");
}
