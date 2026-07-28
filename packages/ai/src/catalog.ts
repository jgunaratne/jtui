import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GoogleAuth } from "google-auth-library";
import type { VertexCredentials } from "./auth.ts";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Which request format a model speaks. */
export type ModelApi = "gemini" | "anthropic";

/**
 * Model Garden publishers to enumerate.
 *
 * Only the publisher list is fixed — the models under each publisher are read
 * live from the API, so a model that appears in your project shows up without
 * a jtui release. Publishers with no adapter yet are still discovered and
 * reported, just marked unsupported.
 */
export const PUBLISHERS = [
	"google",
	"anthropic",
	"meta",
	"mistralai",
	"ai21",
	"cohere",
	"deepseek-ai",
	"qwen",
	"openai",
	"nvidia",
] as const;

export type Publisher = (typeof PUBLISHERS)[number];

/** Publishers jtui can actually send requests to. */
const PUBLISHER_APIS: Partial<Record<string, ModelApi>> = {
	google: "gemini",
	anthropic: "anthropic",
};

export interface CatalogEntry {
	id: string;
	publisher: string;
	/** Undefined when jtui has no adapter for this publisher. */
	api: ModelApi | undefined;
	/** Version reported by Model Garden, when present. */
	version?: string;
}

export interface ModelCatalog {
	project: string;
	location: string;
	/** Unix millis when this catalog was fetched. */
	fetchedAt: number;
	entries: CatalogEntry[];
}

/** Models jtui can send a request to, sorted by publisher then id. */
export function supportedModels(catalog: ModelCatalog): CatalogEntry[] {
	return catalog.entries.filter((entry) => entry.api !== undefined);
}

interface PublisherModel {
	name?: string;
	versionId?: string;
}

/**
 * Read every model the project can see for one publisher.
 *
 * The Model Garden catalog lives on v1beta1, is not project-scoped, caps page
 * size at 300, and needs the quota-project header for non-Google publishers.
 */
async function fetchPublisher(
	credentials: VertexCredentials,
	publisher: string,
	auth: GoogleAuth,
): Promise<CatalogEntry[]> {
	const client = await auth.getClient();
	const host =
		credentials.location === "global"
			? "aiplatform.googleapis.com"
			: `${credentials.location}-aiplatform.googleapis.com`;
	const base = `https://${host}/v1beta1/publishers/${publisher}/models?pageSize=300`;
	const api = PUBLISHER_APIS[publisher];

	const entries: CatalogEntry[] = [];
	const seen = new Set<string>();
	let pageToken: string | undefined;
	do {
		const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
		const response = await client.request<{ publisherModels?: PublisherModel[]; nextPageToken?: string }>({
			url,
			// Required for third-party publishers; harmless for Google.
			headers: { "x-goog-user-project": credentials.project },
		});
		for (const model of response.data.publisherModels ?? []) {
			const id = model.name?.split("/").pop();
			if (!id || seen.has(id)) continue;
			seen.add(id);
			entries.push({ id, publisher, api, ...(model.versionId ? { version: model.versionId } : {}) });
		}
		pageToken = response.data.nextPageToken;
	} while (pageToken);
	return entries;
}

/**
 * Discover every model available to this project and location, across all
 * publishers. Publishers the project cannot see are skipped silently.
 */
export async function fetchCatalog(credentials: VertexCredentials): Promise<ModelCatalog> {
	const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
	const results = await Promise.all(
		PUBLISHERS.map((publisher) => fetchPublisher(credentials, publisher, auth).catch(() => [] as CatalogEntry[])),
	);
	const entries = results.flat().sort((a, b) => {
		if (a.publisher !== b.publisher) return a.publisher.localeCompare(b.publisher);
		return a.id.localeCompare(b.id);
	});
	if (entries.length === 0) {
		throw new Error(
			`No models visible to project "${credentials.project}" in "${credentials.location}". Check that the Vertex AI API is enabled and the location is valid.`,
		);
	}
	return { project: credentials.project, location: credentials.location, fetchedAt: Date.now(), entries };
}

function cachePath(credentials: VertexCredentials): string {
	return join(homedir(), ".jtui", "catalog", `${credentials.project}-${credentials.location}.json`);
}

function readCache(credentials: VertexCredentials): ModelCatalog | undefined {
	const path = cachePath(credentials);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelCatalog;
		if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function writeCache(catalog: ModelCatalog): void {
	const path = join(homedir(), ".jtui", "catalog", `${catalog.project}-${catalog.location}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

export interface CatalogOptions {
	/** Ignore the cache and re-query the API. */
	refresh?: boolean;
	/** How long a cached catalog stays fresh. Defaults to 24 hours. */
	maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Get the model catalog, preferring a recent local cache.
 *
 * Discovery costs a handful of API calls, so the result is cached per
 * project/location. A stale cache is still returned if the refresh fails, so
 * losing network access does not leave the CLI with no models.
 */
export async function loadCatalog(credentials: VertexCredentials, options: CatalogOptions = {}): Promise<ModelCatalog> {
	const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const cached = readCache(credentials);
	if (!options.refresh && cached && Date.now() - cached.fetchedAt < maxAge) return cached;

	try {
		const catalog = await fetchCatalog(credentials);
		writeCache(catalog);
		return catalog;
	} catch (error) {
		if (cached) return cached;
		throw error;
	}
}
