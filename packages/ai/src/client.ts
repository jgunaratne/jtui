import { AnthropicApi } from "./api/anthropic.ts";
import { GeminiApi } from "./api/gemini.ts";
import type { VertexCredentials } from "./auth.ts";
import { type CatalogEntry, type ModelApi, type ModelCatalog, supportedModels } from "./catalog.ts";
import { inferApi, type PricingTable } from "./models.ts";
import type { Context, StreamEvent, StreamOptions } from "./types.ts";

export interface VertexClientOptions {
	/**
	 * Discovered models. Used to route a model id to the right API; when a
	 * model is absent the id itself is used to infer the API, so an id that
	 * predates the cached catalog still works.
	 */
	catalog?: ModelCatalog;
	/** Per-model rates, from user configuration. Absent means cost is unknown. */
	pricing?: PricingTable;
}

/** Raised when a model id cannot be routed to a supported API. */
export class UnsupportedModelError extends Error {
	readonly model: string;
	readonly hints: string[];

	constructor(model: string, hints: string[]) {
		super(`Cannot determine how to call model "${model}".`);
		this.name = "UnsupportedModelError";
		this.model = model;
		this.hints = hints;
	}
}

/**
 * Vertex AI client for one project and location.
 *
 * Routes each request to the API its publisher speaks — Gemini models through
 * the Google GenAI API, Claude models through the Anthropic Messages API —
 * behind one streaming interface.
 */
export class VertexClient {
	readonly credentials: VertexCredentials;
	catalog: ModelCatalog | undefined;
	/** Rates in use, so a client rebuilt for another region can inherit them. */
	readonly pricing: PricingTable;
	private readonly gemini: GeminiApi;
	private readonly anthropic: AnthropicApi;

	constructor(credentials: VertexCredentials, options: VertexClientOptions = {}) {
		this.credentials = credentials;
		this.catalog = options.catalog;
		this.pricing = options.pricing ?? {};
		const rate = (model: string) => this.pricing[model];
		this.gemini = new GeminiApi(credentials, rate);
		this.anthropic = new AnthropicApi(credentials, rate);
	}

	/** Catalog entry for a model id, if it was discovered. */
	entryFor(model: string): CatalogEntry | undefined {
		return this.catalog?.entries.find((entry) => entry.id === model);
	}

	/**
	 * Decide which API a model speaks, preferring the discovered catalog and
	 * falling back to the id itself.
	 */
	resolveApi(model: string): ModelApi {
		const entry = this.entryFor(model);
		if (entry?.api) return entry.api;
		const inferred = inferApi(model);
		if (inferred) return inferred;

		const hints: string[] = [];
		if (entry) {
			hints.push(
				`"${model}" is published by "${entry.publisher}", which jtui cannot call yet. Supported publishers: google, anthropic.`,
			);
		} else {
			hints.push(`"${model}" was not found in this project's model catalog.`);
		}
		hints.push("Run 'jtui models' to see what this project can use.");
		const available = this.catalog ? supportedModels(this.catalog).slice(0, 6) : [];
		if (available.length > 0) {
			hints.push(`For example: ${available.map((entry) => entry.id).join(", ")}`);
		}
		throw new UnsupportedModelError(model, hints);
	}

	/**
	 * Stream one assistant turn.
	 *
	 * Never throws for request failures: they arrive as a final `done` event
	 * whose message has `stopReason` "error".
	 */
	stream(model: string, context: Context, options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
		const api = this.resolveApi(model);
		return api === "anthropic"
			? this.anthropic.stream(model, context, options)
			: this.gemini.stream(model, context, options);
	}
}
