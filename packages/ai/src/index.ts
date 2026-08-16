export {
	AntigravityClient,
	AntigravityCliNotFoundError,
	discoverAntigravityModels,
	findAntigravityCli,
} from "./antigravity.ts";
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
	adapterModels,
	type CatalogEntry,
	type CatalogOptions,
	callableModels,
	conversationalModels,
	fetchCatalog,
	loadCatalog,
	type ModelApi,
	type ModelCatalog,
	PUBLISHERS,
	type Publisher,
	saveCatalog,
	supportedModels,
} from "./catalog.ts";
export { UnsupportedModelError, VertexClient, type VertexClientOptions } from "./client.ts";
export type { EngineMode, ModelClient } from "./engine.ts";
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
export {
	applyProbeResults,
	condenseError,
	type ProbeOptions,
	type ProbeResult,
	probeModel,
	probeModels,
} from "./probe.ts";
export * from "./types.ts";
export { latestModels, type ModelVersion, parseModelVersion } from "./versions.ts";
