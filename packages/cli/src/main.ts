import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@jtui/agent";
import { createState, listSessions, loadSession, newSessionId, Session } from "@jtui/agent";
import {
	AntigravityClient,
	AntigravityCliNotFoundError,
	adapterModels,
	applyProbeResults,
	callableModels,
	conversationalModels,
	discoverAntigravityModels,
	type EngineMode,
	findAntigravityCli,
	loadCatalog,
	type ModelCatalog,
	type ModelClient,
	probeModels,
	saveCatalog,
	supportedModels,
	UnsupportedModelError,
	VertexAuthError,
	VertexClient,
	type VertexCredentials,
	verifyCredentials,
} from "@jtui/ai";
import { parseArgs, USAGE } from "./args.ts";
import { loadConfig, pickDefaultModel, sessionsDir } from "./config.ts";
import { runInteractive } from "./modes/interactive.ts";
import { runPrint } from "./modes/print.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { createDefaultTools } from "./tools/index.ts";

function readVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		// Resolves for both src/ (dev) and dist/ (built) layouts.
		return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
	} catch {
		return "0.0.0";
	}
}

/**
 * Send one real request to every model with an adapter and record which
 * answered, so the listing reflects access rather than what Model Garden
 * advertises. Progress goes to stderr, leaving stdout the plain listing.
 */
async function checkModels(
	catalog: ModelCatalog,
	credentials: VertexCredentials,
	fileConfig: { pricing?: VertexClient["pricing"] },
): Promise<ModelCatalog> {
	const client = new VertexClient(credentials, {
		catalog,
		...(fileConfig.pricing ? { pricing: fileConfig.pricing } : {}),
	});
	const targets = adapterModels(catalog);
	process.stderr.write(`Checking ${targets.length} model(s)...\n`);
	const results = await probeModels(client, targets, {
		onResult: (result, done, total) => {
			const mark = result.available ? "ok  " : "fail";
			process.stderr.write(`  [${done}/${total}] ${mark} ${result.id}\n`);
		},
	});
	const checked: ModelCatalog = { ...catalog, entries: applyProbeResults(catalog.entries, results) };
	saveCatalog(checked);
	const failed = results.filter((result) => !result.available).length;
	process.stderr.write(`Checked ${results.length}; ${failed} unavailable.\n\n`);
	return checked;
}

/**
 * Honour an explicit `-m`, then a saved default only when the selected engine's
 * catalog knows the id. The gcloud and antigravity engines expose different
 * model lists, so a default saved under one must not silently run under the
 * other.
 */
function configuredModel(
	args: ReturnType<typeof parseArgs>,
	fileConfig: ReturnType<typeof loadConfig>,
	catalog: ModelCatalog | undefined,
): string | undefined {
	if (args.model) return args.model;
	if (!fileConfig.model) return undefined;
	if (catalog && !callableModels(catalog).some((entry) => entry.id === fileConfig.model)) {
		process.stderr.write(`jtui: saved model "${fileConfig.model}" is not available in this engine; picking another.\n`);
		return undefined;
	}
	return fileConfig.model;
}

/**
 * Resolve a default model that answers a real request.
 *
 * Model Garden lists models the project cannot call, and an unreleased id often
 * outranks the working one, so trusting the catalog can settle on a model whose
 * first turn 404s. Probe the unchecked conversational candidates once (results
 * are cached in the catalog), then pick from what actually responded.
 */
async function resolveDefaultModel(
	client: VertexClient,
	catalog: ModelCatalog,
): Promise<{ model: string | undefined; catalog: ModelCatalog }> {
	const unchecked = conversationalModels(catalog).filter((entry) => entry.checkedAt === undefined);
	if (unchecked.length === 0) {
		return { model: pickDefaultModel(supportedModels(catalog).map((entry) => entry.id)), catalog };
	}
	process.stderr.write(`jtui: verifying ${unchecked.length} model(s) to pick a default...\n`);
	const results = await probeModels(client, unchecked, {
		onResult: (result, done, total) => {
			const mark = result.available ? "ok  " : "fail";
			process.stderr.write(`  [${done}/${total}] ${mark} ${result.id}\n`);
		},
	});
	const checked: ModelCatalog = { ...catalog, entries: applyProbeResults(catalog.entries, results) };
	saveCatalog(checked);
	client.catalog = checked;
	return { model: pickDefaultModel(supportedModels(checked).map((entry) => entry.id)), catalog: checked };
}

/**
 * Load environment from `.env`, so deployment-specific and sensitive settings
 * (such as the Antigravity CLI path) stay out of the committed source.
 *
 * `loadEnvFile` never overwrites a variable already set, so the order is
 * precedence order: an exported variable wins, then the working directory's
 * `.env`, then the user config dir. Missing files are ignored.
 */
function loadEnvFiles(cwd: string): void {
	for (const path of [join(cwd, ".env"), join(homedir(), ".jtui", ".env")]) {
		try {
			process.loadEnvFile(path);
		} catch {
			// No .env at this location, or it is unreadable; that is fine.
		}
	}
}

/** Print an auth failure with its setup hints. */
function reportAuthError(error: VertexAuthError): void {
	process.stderr.write(`jtui: ${error.message}\n`);
	for (const hint of error.hints) process.stderr.write(`  ${hint}\n`);
}

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.errors.length > 0) {
		for (const error of args.errors) process.stderr.write(`jtui: ${error}\n`);
		process.stderr.write("\nRun 'jtui --help' for usage.\n");
		return 2;
	}
	if (args.command === "help") {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (args.command === "version") {
		process.stdout.write(`${readVersion()}\n`);
		return 0;
	}

	const cwd = process.cwd();
	loadEnvFiles(cwd);
	const fileConfig = loadConfig(cwd);

	if (args.command === "sessions") {
		const summaries = listSessions(sessionsDir(cwd));
		if (summaries.length === 0) {
			process.stdout.write("No sessions in this directory.\n");
			return 0;
		}
		for (const summary of summaries) {
			process.stdout.write(`${summary.id}  ${String(summary.messageCount).padStart(4)} msgs  ${summary.firstPrompt}\n`);
		}
		return 0;
	}

	const engine: EngineMode = args.engine ?? fileConfig.engine ?? "gcloud";

	// ---- Antigravity CLI path ----
	if (engine === "antigravity") {
		const cliPath = findAntigravityCli();
		if (!cliPath) {
			const error = new AntigravityCliNotFoundError();
			process.stderr.write(`jtui: ${error.message}\n`);
			for (const hint of error.hints) process.stderr.write(`  ${hint}\n`);
			return 1;
		}

		if (args.command === "auth") {
			process.stdout.write("Antigravity mode — authentication is handled by the Antigravity CLI.\n");
			process.stdout.write(`  cli  ${cliPath}\n`);
			return 0;
		}

		let catalog: ModelCatalog | undefined;
		try {
			catalog = await discoverAntigravityModels(cliPath);
		} catch (error) {
			if (args.command === "models") {
				process.stderr.write(`jtui: could not list models: ${(error as Error).message}\n`);
				return 1;
			}
			process.stderr.write(`jtui: model discovery failed (${(error as Error).message})\n`);
		}

		if (args.command === "models") {
			if (!catalog) return 1;
			const entries = supportedModels(catalog);
			let publisher = "";
			for (const entry of entries) {
				if (entry.publisher !== publisher) {
					publisher = entry.publisher;
					process.stdout.write(`${publisher}\n`);
				}
				process.stdout.write(`  ${entry.id}\n`);
			}
			return 0;
		}

		const available = catalog ? supportedModels(catalog).map((entry) => entry.id) : [];
		const model = configuredModel(args, fileConfig, catalog) ?? pickDefaultModel(available);
		if (!model) {
			process.stderr.write("jtui: no usable model found. Run 'jtui models' to see what this project can call.\n");
			return 1;
		}

		const client: ModelClient = new AntigravityClient(cliPath, { catalog, pricing: fileConfig.pricing });
		return runWithClient(client, model, args, fileConfig, cwd);
	}

	// ---- gcloud (Vertex AI) path ----
	let credentials: Awaited<ReturnType<typeof verifyCredentials>>;
	try {
		credentials = await verifyCredentials({
			project: args.project ?? fileConfig.project,
			location: args.location ?? fileConfig.location,
			credentialsFile: args.credentialsFile,
		});
	} catch (error) {
		if (error instanceof VertexAuthError) {
			reportAuthError(error);
			return 1;
		}
		throw error;
	}

	if (args.command === "auth") {
		process.stdout.write("Google Cloud credentials OK\n");
		process.stdout.write(`  project     ${credentials.project} (${credentials.projectSource})\n`);
		process.stdout.write(`  location    ${credentials.location}\n`);
		process.stdout.write(`  credentials ${credentials.credentialSource}\n`);
		return 0;
	}

	// Discovery is shared by the models command and normal runs.
	let catalog: ModelCatalog | undefined;
	try {
		catalog = await loadCatalog(credentials, { refresh: args.refresh });
	} catch (error) {
		if (args.command === "models") {
			process.stderr.write(`jtui: could not list models: ${(error as Error).message}\n`);
			return 1;
		}
		// A run can still proceed with an explicit model id.
		process.stderr.write(`jtui: model discovery failed (${(error as Error).message})\n`);
	}

	if (args.command === "models") {
		if (!catalog) return 1;

		if (args.check) {
			catalog = await checkModels(catalog, credentials, fileConfig);
		}

		const age = Math.round((Date.now() - catalog.fetchedAt) / 60_000);
		process.stdout.write(`Models for ${catalog.project} in ${catalog.location}`);
		process.stdout.write(age > 0 ? ` (cached ${age}m ago; --refresh to update)\n\n` : `\n\n`);

		const usable = supportedModels(catalog);
		const shown = new Set(usable.map((entry) => entry.id));

		let publisher = "";
		for (const entry of catalog.entries) {
			if (!args.all && !entry.api) continue;
			// A model a check proved uncallable is noise in the default listing.
			if (!args.all && entry.available === false) continue;
			// So is an older release of a line that has a newer one.
			if (!args.all && !shown.has(entry.id)) continue;
			if (entry.publisher !== publisher) {
				publisher = entry.publisher;
				process.stdout.write(`${publisher}\n`);
			}
			const note = entry.api
				? entry.available === false
					? `  (unavailable: ${entry.unavailableReason ?? "request failed"})`
					: shown.has(entry.id)
						? ""
						: "  (superseded)"
				: "  (no jtui adapter)";
			process.stdout.write(`  ${entry.id}${note}\n`);
		}

		if (!args.all) {
			const otherPublishers = catalog.entries.filter((entry) => !entry.api).length;
			if (otherPublishers > 0) {
				process.stdout.write(`\n${otherPublishers} model(s) from other publishers hidden; --all to show.\n`);
			}
			const callable = callableModels(catalog);
			const failed = adapterModels(catalog).length - callable.length;
			if (failed > 0) process.stdout.write(`${failed} model(s) hidden after a failed check; --all to show why.\n`);
			const superseded = callable.length - usable.length;
			if (superseded > 0) process.stdout.write(`${superseded} older version(s) hidden; --all to show.\n`);
		}

		const unchecked = usable.filter((entry) => entry.checkedAt === undefined).length;
		process.stdout.write(
			unchecked > 0
				? `\n${unchecked} model(s) never checked; listing does not prove access. Run 'jtui models --check'.\n`
				: "\nAll listed models answered a real request.\n",
		);
		return 0;
	}

	const client = new VertexClient(credentials, { catalog, pricing: fileConfig.pricing });

	// An explicit choice is honoured as-is; only a default is verified, since
	// the catalog alone cannot tell a callable model from one merely listed.
	let model = configuredModel(args, fileConfig, catalog);
	if (!model && catalog) {
		const resolved = await resolveDefaultModel(client, catalog);
		catalog = resolved.catalog;
		model = resolved.model;
	}
	if (!model) {
		process.stderr.write("jtui: no usable model found. Run 'jtui models' to see what this project can call.\n");
		return 1;
	}

	try {
		// Fail fast on an unroutable model rather than mid-conversation.
		client.resolveApi(model);
	} catch (error) {
		if (error instanceof UnsupportedModelError) {
			process.stderr.write(`jtui: ${error.message}\n`);
			for (const hint of error.hints) process.stderr.write(`  ${hint}\n`);
			return 1;
		}
		throw error;
	}

	return runWithClient(client, model, args, fileConfig, cwd);
}

/** Shared logic once an engine-specific client and model are resolved. */
async function runWithClient(
	client: ModelClient,
	model: string,
	args: ReturnType<typeof parseArgs>,
	fileConfig: ReturnType<typeof loadConfig>,
	cwd: string,
): Promise<number> {
	const { tools, bash } = createDefaultTools(cwd);

	/** Rebuilt on /model so the stated model never goes stale. */
	const systemPromptFor = (id: string) =>
		buildSystemPrompt({
			cwd,
			model: id,
			publisher: client.entryFor(id)?.publisher,
			noProjectContext: args.noProjectContext,
		});

	const config: AgentConfig = {
		model,
		systemPrompt: systemPromptFor(model),
		tools,
		thinking: args.thinking ?? fileConfig.thinking ?? "medium",
		temperature: fileConfig.temperature,
		maxOutputTokens: fileConfig.maxOutputTokens,
		maxTurns: args.maxTurns ?? fileConfig.maxTurns,
		detectLoops: args.noLoopDetection ? false : fileConfig.detectLoops,
		compaction: args.noCompaction ? false : fileConfig.compaction,
	};

	// Resume an existing transcript when asked, otherwise start a fresh one.
	const directory = sessionsDir(cwd);
	let state = createState();
	let sessionId = newSessionId();
	if (args.resume || args.continueSession) {
		const summaries = listSessions(directory);
		const target = args.resume ? summaries.find((entry) => entry.id === args.resume) : summaries[0];
		if (!target) {
			process.stderr.write(`jtui: no session to resume${args.resume ? ` with id ${args.resume}` : ""}.\n`);
			return 1;
		}
		state = loadSession(target.path);
		sessionId = target.id;
	}

	const session = new Session(directory, sessionId, {
		cwd,
		model: config.model,
		startedAt: new Date().toISOString(),
	});
	session.markWritten(state.messages.length);

	if (args.print) {
		return runPrint({
			client,
			config,
			state,
			session,
			prompt: args.prompt ?? "",
			cwd,
			verbose: args.verbose,
			json: args.json,
		});
	}

	if (!process.stdin.isTTY) {
		process.stderr.write("jtui: interactive mode needs a TTY. Use --print with a prompt instead.\n");
		return 2;
	}

	return runInteractive({
		client,
		config,
		state,
		session,
		bash,
		cwd,
		systemPromptFor,
		initialPrompt: args.prompt,
		configuredLocation: args.location ?? fileConfig.location,
	});
}
