import type { CatalogEntry, ModelApi } from "./catalog.ts";

/** Tokens that mark a pre-release rather than part of the model's identity. */
const PREVIEW_TOKENS = new Set(["preview", "exp", "experimental"]);

export interface ModelVersion {
	/**
	 * The model line, with the version removed — `gemini-3.5-flash-lite` and
	 * `gemini-2.5-flash-lite` share the family `gemini-flash-lite`.
	 */
	family: string;
	/** Major.minor as a number, so 3.7 sorts above 3.5 and above 3. */
	version: number;
	preview: boolean;
}

/**
 * Split a model id into the line it belongs to and its version.
 *
 * Ids are not uniform: Gemini carries the version as one token
 * (`gemini-3.7-flash`), Claude splits it across two (`claude-opus-4-8`), and
 * both append revisions (`-001`), dates (`-04-17`, `@20251101`) and preview
 * markers. Everything that is not identity is stripped so two releases of the
 * same line compare directly.
 */
export function parseModelVersion(id: string, api?: ModelApi): ModelVersion {
	const base = id.split("@")[0] ?? id;
	const variant: string[] = [];
	const numbers: number[] = [];
	let preview = false;

	for (const token of base.split("-")) {
		if (PREVIEW_TOKENS.has(token)) {
			preview = true;
			continue;
		}
		// Revision suffixes (001) and dates (20251101) are not versions.
		if (/^\d{3,}$/.test(token)) continue;
		// Date fragments trailing a preview marker, as in "preview-04-17".
		if (preview && /^\d{1,2}$/.test(token)) continue;
		if (/^\d+(?:\.\d+)?$/.test(token)) {
			numbers.push(Number(token));
			continue;
		}
		variant.push(token);
	}

	// Claude spreads major and minor over two tokens; Gemini uses one.
	const major = numbers[0] ?? 0;
	const minor = numbers[1];
	const version = api === "anthropic" && minor !== undefined ? major + minor / 10 : major;
	return { family: variant.join("-"), version, preview };
}

/** Order two releases of the same line, newest first; stable beats preview. */
function compare(a: ModelVersion, b: ModelVersion): number {
	if (a.version !== b.version) return b.version - a.version;
	if (a.preview !== b.preview) return a.preview ? 1 : -1;
	return 0;
}

/**
 * Keep only the newest release of each model line.
 *
 * Model Garden lists every generation a project can see, so a working account
 * shows five vintages of the same flash model. Only the newest is interesting;
 * an older one is still callable by passing its id explicitly.
 */
export function latestModels(entries: CatalogEntry[]): CatalogEntry[] {
	const best = new Map<string, { entry: CatalogEntry; version: ModelVersion }>();
	for (const entry of entries) {
		const version = parseModelVersion(entry.id, entry.api);
		// Publisher joins the key so two publishers cannot collide on a family.
		const key = `${entry.publisher}:${version.family}`;
		const current = best.get(key);
		if (!current || compare(version, current.version) < 0) best.set(key, { entry, version });
	}
	const kept = new Set([...best.values()].map((winner) => winner.entry.id));
	// Preserve the caller's ordering rather than the map's insertion order.
	return entries.filter((entry) => kept.has(entry.id));
}
