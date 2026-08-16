import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionSettings } from "@jtui/agent";
import type { EngineMode, PricingTable, ThinkingLevel } from "@jtui/ai";

export interface JtuiConfig {
	model?: string;
	/** Google Cloud project id. Falls back to ADC / gcloud config. */
	project?: string;
	/** Vertex AI location, e.g. "us-central1" or "global". */
	location?: string;
	thinking?: ThinkingLevel;
	temperature?: number;
	maxOutputTokens?: number;
	maxTurns?: number;
	/** Stop a turn when the model repeats itself. Defaults to true. */
	detectLoops?: boolean;
	/**
	 * Summarize older history as the context window fills. Defaults to on at
	 * 75% of the window; set false to disable.
	 */
	compaction?: CompactionSettings | false;
	/**
	 * Per-model token rates, used only for the local cost estimate. jtui ships
	 * no pricing data because Vertex bills your project's own rates.
	 *
	 * { "claude-sonnet-4-5": { "inputPerMillion": 3, "outputPerMillion": 15 } }
	 */
	pricing?: PricingTable;
	/** Which backend handles model requests: "gcloud" for direct Vertex AI, "antigravity" for the Antigravity CLI. */
	engine?: EngineMode;
}

/**
 * Preference order used to pick a default model when none is configured.
 * Matched against the ids actually available to the project, so the choice
 * adapts to whatever the account can call.
 */
const DEFAULT_MODEL_PREFERENCES = [
	/^gemini-[\d.]+-pro$/,
	/^claude-(opus|sonnet)-[\d-]+$/,
	/^gemini-[\d.]+-flash$/,
	/^gemini-/,
	/^claude-/,
];

/** Choose a sensible default model from the models this project can call. */
export function pickDefaultModel(ids: string[]): string | undefined {
	for (const preference of DEFAULT_MODEL_PREFERENCES) {
		// Newest first within a preference tier.
		const matches = ids.filter((id) => preference.test(id)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
		if (matches[0]) return matches[0];
	}
	return ids[0];
}

/** Per-user config directory. */
export function globalConfigDir(): string {
	return join(homedir(), ".jtui");
}

/** Per-project config and session directory. */
export function projectConfigDir(cwd: string): string {
	return join(cwd, ".jtui");
}

function readConfigFile(path: string): JtuiConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as JtuiConfig;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch (error) {
		process.stderr.write(`jtui: ignoring malformed config at ${path}: ${(error as Error).message}\n`);
		return {};
	}
}

/**
 * Load configuration, with project settings overriding user settings.
 * CLI flags are layered on top by the caller.
 */
export function loadConfig(cwd: string): JtuiConfig {
	return {
		...readConfigFile(join(globalConfigDir(), "config.json")),
		...readConfigFile(join(projectConfigDir(cwd), "config.json")),
	};
}

/** Persist settings to the user-level config file. */
export function saveGlobalConfig(config: JtuiConfig): string {
	const directory = globalConfigDir();
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const merged = { ...readConfigFile(path), ...config };
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	return path;
}

/** Where session transcripts are stored. */
export function sessionsDir(cwd: string): string {
	return join(projectConfigDir(cwd), "sessions");
}
