import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CatalogEntry, ModelApi, ModelCatalog } from "./catalog.ts";
import type { ModelClient } from "./engine.ts";
import type { PricingTable } from "./models.ts";
import type { AssistantMessage, Context, StreamEvent, StreamOptions, Usage } from "./types.ts";

/**
 * Resolve the Antigravity CLI binary from configuration.
 *
 * The install path is deployment-specific and never committed. Point
 * `JTUI_ANTIGRAVITY_CLI` at the binary, or `JTUI_ANTIGRAVITY_CLI_PATH` at a
 * colon-separated list of candidates. See `.env.example`. Returns undefined
 * when nothing is configured or the configured path does not exist.
 */
export function findAntigravityCli(): string | undefined {
	const explicit = process.env.JTUI_ANTIGRAVITY_CLI?.trim();
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	const search = process.env.JTUI_ANTIGRAVITY_CLI_PATH;
	if (!search) return undefined;
	for (const candidate of search.split(":")) {
		const path = candidate.trim();
		if (path && existsSync(path)) return path;
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

// ---------- Antigravity CLI stream-json protocol types ----------

interface CliUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}

interface CliStepUpdate {
	conversation_id: string;
	step_index: number;
	state: string;
	step_type: string;
	text_delta?: string;
	duration_seconds?: number;
	usage?: CliUsage;
}

interface CliResult {
	conversation_id: string;
	status: string;
	response: string;
	error?: string;
	duration_seconds: number;
	num_turns: number;
	usage: CliUsage;
}

interface CliEvent {
	event: "init" | "step_update" | "result";
	step_update?: CliStepUpdate;
	result?: CliResult;
}

function toUsage(usage: CliUsage | undefined): Usage {
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
 * Pull the indented model list out of an "Available models:" block.
 *
 * The names are display labels ("Claude Opus 4.6 (Thinking)"), not the ids
 * Model Garden uses, so the two catalogs never line up — the Antigravity CLI is
 * its own source of truth.
 */
function matchModelList(text: string): string[] | undefined {
	const match = /Available models:\n((?:\s+.+\n?)+)/i.exec(text);
	if (!match?.[1]) return undefined;
	const names = match[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return names.length > 0 ? names : undefined;
}

/**
 * Find the model list in the CLI's output.
 *
 * With `--output-format=stream-json` the error is a JSON string whose newlines
 * are escaped, so the block must be read from the decoded `result.error` rather
 * than the raw bytes. Older text-mode builds are handled by the raw fallback.
 */
function parseModelNames(stdout: string, stderr: string): string[] | undefined {
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		let event: CliEvent;
		try {
			event = JSON.parse(line) as CliEvent;
		} catch {
			continue;
		}
		const error = event.result?.error;
		if (error) {
			const names = matchModelList(error);
			if (names) return names;
		}
	}
	return matchModelList(stdout + stderr);
}

/**
 * Discover models by asking the Antigravity CLI for its model list.
 *
 * Uses a deliberate invalid model name, which causes the CLI to list all
 * available models in its error message.
 */
export async function discoverAntigravityModels(cliPath: string): Promise<ModelCatalog> {
	return new Promise<ModelCatalog>((resolve, reject) => {
		const child = spawn(
			cliPath,
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
			const names = parseModelNames(stdout, stderr);
			if (!names) {
				reject(new Error(`Could not discover Antigravity models. Output: ${(stdout + stderr).slice(0, 500)}`));
				return;
			}

			const entries: CatalogEntry[] = names.map((name) => {
				const lower = name.toLowerCase();
				const publisher = lower.includes("claude") ? "anthropic" : "google";
				const api: ModelApi | undefined = publisher === "anthropic" ? "anthropic" : "gemini";
				return { id: name, publisher, api, available: true };
			});

			resolve({
				project: "antigravity",
				location: "cli",
				fetchedAt: Date.now(),
				entries,
			});
		});

		child.on("error", reject);
	});
}

// ---------- AntigravityClient ----------

/** Error raised when the Antigravity CLI is not installed or configured. */
export class AntigravityCliNotFoundError extends Error {
	readonly hints: string[];

	constructor() {
		super("Antigravity CLI not found.");
		this.name = "AntigravityCliNotFoundError";
		this.hints = [
			"Set JTUI_ANTIGRAVITY_CLI to the Antigravity CLI binary (see .env.example).",
			"Or switch to gcloud mode: jtui --engine gcloud",
		];
	}
}

/**
 * Model client that routes requests through the Antigravity CLI.
 *
 * Each stream() call spawns the CLI with `--print --output-format=stream-json`
 * and translates the JSONL events into the same StreamEvent protocol that
 * VertexClient produces.
 */
export class AntigravityClient implements ModelClient {
	readonly cliPath: string;
	catalog: ModelCatalog | undefined;
	readonly pricing: PricingTable;

	constructor(cliPath: string, options: { catalog?: ModelCatalog; pricing?: PricingTable } = {}) {
		this.cliPath = cliPath;
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

		// The Antigravity CLI has no `--effort`/thinking flag; the thinking mode is
		// baked into the model name (e.g. "Claude Opus 4.6 (Thinking)"), so
		// `options.thinking` is intentionally not forwarded here. Passing --effort
		// makes the CLI reject the request.
		const args = [
			`--print=${prompt}`,
			"--output-format=stream-json",
			`--model=${model}`,
			"--dangerously-skip-permissions",
			"--print-timeout=300s",
		];

		const child = spawn(this.cliPath, args, {
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
			let parsed: CliEvent;
			try {
				parsed = JSON.parse(line) as CliEvent;
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
