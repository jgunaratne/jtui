import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@jtui/agent";
import { createState, listSessions, loadSession, newSessionId, Session } from "@jtui/agent";
import {
	loadCatalog,
	type ModelCatalog,
	supportedModels,
	UnsupportedModelError,
	VertexAuthError,
	VertexClient,
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
		const age = Math.round((Date.now() - catalog.fetchedAt) / 60_000);
		process.stdout.write(`Models for ${catalog.project} in ${catalog.location}`);
		process.stdout.write(age > 0 ? ` (cached ${age}m ago; --refresh to update)\n\n` : `\n\n`);

		let publisher = "";
		for (const entry of catalog.entries) {
			if (!args.all && !entry.api) continue;
			if (entry.publisher !== publisher) {
				publisher = entry.publisher;
				process.stdout.write(`${publisher}\n`);
			}
			const note = entry.api ? "" : "  (no jtui adapter)";
			process.stdout.write(`  ${entry.id}${note}\n`);
		}
		if (!args.all) {
			const hidden = catalog.entries.length - supportedModels(catalog).length;
			if (hidden > 0) process.stdout.write(`\n${hidden} model(s) from other publishers hidden; --all to show.\n`);
		}
		process.stdout.write("\nListed models still need access granted in Vertex AI Model Garden.\n");
		return 0;
	}

	const available = catalog ? supportedModels(catalog).map((entry) => entry.id) : [];
	const model = args.model ?? fileConfig.model ?? pickDefaultModel(available);
	if (!model) {
		process.stderr.write("jtui: no usable model found. Run 'jtui models' to see what this project can call.\n");
		return 1;
	}

	const client = new VertexClient(credentials, { catalog, pricing: fileConfig.pricing });
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

	const { tools, bash } = createDefaultTools(cwd);

	const config: AgentConfig = {
		model,
		systemPrompt: buildSystemPrompt({ cwd, noProjectContext: args.noProjectContext }),
		tools,
		thinking: args.thinking ?? fileConfig.thinking ?? "medium",
		temperature: fileConfig.temperature,
		maxOutputTokens: fileConfig.maxOutputTokens,
		maxTurns: args.maxTurns ?? fileConfig.maxTurns,
		detectLoops: args.noLoopDetection ? false : fileConfig.detectLoops,
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
		initialPrompt: args.prompt,
	});
}
