import type { CatalogEntry } from "./catalog.ts";
import type { VertexClient } from "./client.ts";
import type { Context } from "./types.ts";

/** Outcome of sending one real request to a model. */
export interface ProbeResult {
	id: string;
	available: boolean;
	/** Condensed failure reason, when the request failed. */
	reason?: string;
}

/** Smallest request that still proves the model will answer. */
const PROBE_CONTEXT: Context = { messages: [{ role: "user", content: "hi" }] };

/** Find the first `error.message` in a parsed body, array-wrapped or not. */
function findErrorMessage(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findErrorMessage(item);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof value === "object" && value !== null) {
		const error = (value as { error?: { message?: unknown } }).error;
		if (error && typeof error.message === "string") return error.message;
	}
	return undefined;
}

/**
 * Return the balanced JSON value starting at `start`.
 *
 * Slicing to the end of the string is not enough: `formatVertexError` appends
 * advice after the body, which would make the parse fail.
 */
function jsonSpan(text: string, start: number): string | undefined {
	const open = text[start];
	const close = open === "[" ? "]" : "}";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === open) depth++;
		else if (char === close && --depth === 0) return text.slice(start, index + 1);
	}
	return undefined;
}

/** Unwrap one layer of JSON envelope, returning the nested error message. */
function extractMessage(text: string): string | undefined {
	const start = text.search(/[[{]/);
	if (start === -1) return undefined;
	const span = jsonSpan(text, start);
	if (span === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(span);
	} catch {
		// Not JSON, or truncated mid-body.
		return undefined;
	}
	const inner = findErrorMessage(parsed);
	if (inner === undefined) return undefined;
	// Vertex sometimes encodes a whole JSON document inside `message`.
	return extractMessage(inner) ?? inner;
}

/**
 * Pull a human-sized reason out of a Vertex error.
 *
 * Errors arrive as a status code followed by the raw JSON body, and the Gemini
 * API nests a second encoded document inside `error.message`. The useful part
 * is the innermost message, otherwise buried in hundreds of characters.
 */
export function condenseError(message: string): string {
	return truncate(extractMessage(message) ?? message);
}

function truncate(text: string, limit = 160): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/**
 * Send one minimal request to a model and report whether it answered.
 *
 * Any terminal state other than `error` counts as available: hitting the output
 * limit or a safety filter still proves the project may call the model.
 *
 * The request deliberately overrides nothing but the output cap. Forcing a
 * thinking level here would fail models that reject that particular level and
 * report them as unavailable when a normal run would have worked.
 */
export async function probeModel(client: VertexClient, id: string, signal?: AbortSignal): Promise<ProbeResult> {
	try {
		for await (const event of client.stream(id, PROBE_CONTEXT, {
			maxOutputTokens: 256,
			...(signal ? { signal } : {}),
		})) {
			if (event.type !== "done") continue;
			const { stopReason, errorMessage } = event.message;
			if (stopReason !== "error") return { id, available: true };
			return { id, available: false, reason: condenseError(errorMessage ?? "request failed") };
		}
		return { id, available: false, reason: "no response" };
	} catch (error) {
		// Routing failures (no adapter for the publisher) throw rather than stream.
		return { id, available: false, reason: condenseError((error as Error).message) };
	}
}

export interface ProbeOptions {
	/** How many models to probe at once. Defaults to 4. */
	concurrency?: number;
	/** Called as each result lands, for progress reporting. */
	onResult?: (result: ProbeResult, done: number, total: number) => void;
	signal?: AbortSignal;
}

/**
 * Probe every entry, a few at a time.
 *
 * Concurrency is deliberately low: this fires real billable requests, and a
 * burst across every model in a project invites rate limiting.
 */
export async function probeModels(
	client: VertexClient,
	entries: CatalogEntry[],
	options: ProbeOptions = {},
): Promise<ProbeResult[]> {
	const { concurrency = 4, onResult, signal } = options;
	const results: ProbeResult[] = new Array(entries.length);
	let next = 0;
	let done = 0;

	async function worker(): Promise<void> {
		while (true) {
			const index = next++;
			const entry = entries[index];
			if (!entry) return;
			results[index] = await probeModel(client, entry.id, signal);
			done += 1;
			onResult?.(results[index], done, entries.length);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
	return results;
}

/** Apply probe results to catalog entries, stamping the time of the check. */
export function applyProbeResults(entries: CatalogEntry[], results: ProbeResult[], now = Date.now()): CatalogEntry[] {
	const byId = new Map(results.map((result) => [result.id, result]));
	return entries.map((entry) => {
		const result = byId.get(entry.id);
		if (!result) return entry;
		const { unavailableReason: _drop, ...rest } = entry;
		return {
			...rest,
			available: result.available,
			...(result.reason ? { unavailableReason: result.reason } : {}),
			checkedAt: now,
		};
	});
}
