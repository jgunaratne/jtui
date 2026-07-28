import type { ModelApi } from "./catalog.ts";
import type { Usage } from "./types.ts";

/**
 * Per-million-token rates. jtui ships no pricing data — Vertex bills your
 * project's own rates, which vary by contract — so this is populated only from
 * user configuration.
 */
export interface ModelPricing {
	inputPerMillion: number;
	outputPerMillion: number;
	cachedInputPerMillion?: number;
}

export type PricingTable = Record<string, ModelPricing>;

/** How a model expects thinking to be configured. */
export type ThinkingStyle =
	/** Gemini 3+: categorical thinking level. */
	| "gemini-level"
	/** Gemini 2.x: numeric thinking budget. */
	| "gemini-budget"
	/** Claude 4.6+: `{type: "adaptive"}` plus an effort level. */
	| "anthropic-adaptive"
	/** Claude 4.5 and older: `{type: "enabled", budget_tokens: N}`. */
	| "anthropic-budget";

export interface ModelCapabilities {
	id: string;
	api: ModelApi;
	contextWindow: number;
	maxOutputTokens: number;
	thinking: ThinkingStyle;
	/** Whether the model accepts `output_config.effort` (Anthropic only). */
	supportsEffort: boolean;
}

/** Decide which API a model id speaks when it is not in the catalog. */
export function inferApi(id: string): ModelApi | undefined {
	if (id.startsWith("claude")) return "anthropic";
	if (id.startsWith("gemini")) return "gemini";
	return undefined;
}

interface ClaudeVersion {
	family: string | undefined;
	/** Major.minor as a number, e.g. 4.8, so ranges are easy to express. */
	version: number;
}

/**
 * Extract the family and version from a Claude model id.
 *
 * Handles current ids (`claude-opus-4-8`, `claude-opus-5`), dated snapshots
 * (`claude-opus-4-5@20251101`) and legacy ordering (`claude-3-5-sonnet-...`).
 * Deriving capabilities from the version rather than a fixed list means new
 * models are handled correctly the day they appear.
 */
function parseClaudeVersion(id: string): ClaudeVersion {
	const base = id.split("@")[0] ?? id;
	const family = /(opus|sonnet|haiku|fable|mythos)/.exec(base)?.[1];
	// Date suffixes are far larger than any version component; ignore them.
	const numbers = (base.match(/\d+/g) ?? []).map(Number).filter((value) => value < 100);
	const major = numbers[0] ?? 0;
	const minor = numbers[1] ?? 0;
	return { family, version: major + minor / 10 };
}

/**
 * Capabilities for a model id, derived from its family and version.
 *
 * These are defaults, not a whitelist: any model id can be used. If a default
 * is wrong for a new model the API rejects the request and the error is
 * surfaced verbatim.
 */
export function getCapabilities(id: string, api: ModelApi): ModelCapabilities {
	if (api === "anthropic") {
		const { family, version } = parseClaudeVersion(id);
		// Adaptive thinking replaced token budgets in the 4.6 generation.
		const adaptive = version >= 4.6 || family === "fable" || family === "mythos";
		return {
			id,
			api,
			contextWindow: adaptive ? 1_000_000 : 200_000,
			maxOutputTokens: adaptive ? 64_000 : version >= 4.5 ? 32_000 : 8_192,
			thinking: adaptive ? "anthropic-adaptive" : "anthropic-budget",
			// `effort` arrived with the 4.5 generation; older models reject it.
			supportsEffort: adaptive || version >= 4.5,
		};
	}
	// Gemini 3 takes a categorical thinking level; 2.x takes a token budget.
	const level = /^gemini-(?:[3-9]|\d{2,})/.test(id);
	return {
		id,
		api,
		contextWindow: 1_048_576,
		maxOutputTokens: 65_536,
		thinking: level ? "gemini-level" : "gemini-budget",
		supportsEffort: false,
	};
}

/** Estimate request cost, or 0 when no rate is configured for the model. */
export function calculateCost(pricing: ModelPricing | undefined, usage: Omit<Usage, "costUsd">): number {
	if (!pricing) return 0;
	const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
	const uncachedInput = Math.max(0, usage.input - usage.cacheRead);
	return (
		(uncachedInput * pricing.inputPerMillion) / 1_000_000 +
		(usage.cacheRead * cachedRate) / 1_000_000 +
		(usage.output * pricing.outputPerMillion) / 1_000_000
	);
}
