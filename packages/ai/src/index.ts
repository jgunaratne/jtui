export { AnthropicApi } from "./api/anthropic.ts";
export { convertMessages, convertTools, GeminiApi } from "./api/gemini.ts";
export {
	adcPath,
	type CredentialOverrides,
	resolveCredentials,
	VertexAuthError,
	type VertexCredentials,
	verifyCredentials,
} from "./auth.ts";
export {
	type CatalogEntry,
	type CatalogOptions,
	fetchCatalog,
	loadCatalog,
	type ModelApi,
	type ModelCatalog,
	PUBLISHERS,
	type Publisher,
	supportedModels,
} from "./catalog.ts";
export { UnsupportedModelError, VertexClient, type VertexClientOptions } from "./client.ts";
export { formatVertexError } from "./errors.ts";
export {
	calculateCost,
	getCapabilities,
	inferApi,
	type ModelCapabilities,
	type ModelPricing,
	type PricingTable,
	type ThinkingStyle,
} from "./models.ts";
export * from "./types.ts";
