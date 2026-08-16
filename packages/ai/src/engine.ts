import type { CatalogEntry, ModelApi, ModelCatalog } from "./catalog.ts";
import type { PricingTable } from "./models.ts";
import type { Context, StreamEvent, StreamOptions } from "./types.ts";

/** Which backend handles model requests. */
export type EngineMode = "gcloud" | "antigravity";

/**
 * Common interface for model backends.
 *
 * VertexClient (gcloud) calls Vertex AI directly; AntigravityClient routes
 * through the Jetski CLI. Consumers that only need to stream should accept
 * this interface rather than a concrete class.
 */
export interface ModelClient {
	/** Stream one assistant turn. */
	stream(model: string, context: Context, options?: StreamOptions): AsyncGenerator<StreamEvent>;
	/** Catalog entry for a model id, if it was discovered. */
	entryFor(model: string): CatalogEntry | undefined;
	/** Resolve which API a model speaks. */
	resolveApi(model: string): ModelApi;
	/** Discovered models. */
	catalog: ModelCatalog | undefined;
	/** Per-model rates, from user configuration. */
	readonly pricing: PricingTable;
}
