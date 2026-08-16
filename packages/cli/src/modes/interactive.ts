import {
	type AgentConfig,
	type AgentState,
	compact,
	contextUsage,
	runAgent,
	type Session,
	type ToolExecution,
} from "@jtui/agent";
import {
	AntigravityClient,
	AntigravityCliNotFoundError,
	adapterModels,
	applyProbeResults,
	type CatalogEntry,
	callableModels,
	conversationalModels,
	discoverAntigravityModels,
	type EngineMode,
	findAntigravityCli,
	loadCatalog,
	type ModelClient,
	messageText,
	probeModels,
	saveCatalog,
	supportedModels,
	UnsupportedModelError,
	VertexAuthError,
	VertexClient,
	verifyCredentials,
} from "@jtui/ai";
import {
	type Component,
	Container,
	Editor,
	Loader,
	ProcessTerminal,
	renderMarkdown,
	type SelectItem,
	SelectList,
	styles,
	TUI,
	truncateToWidth,
} from "@jtui/tui";
import { pickDefaultModel, saveGlobalConfig } from "../config.ts";
import { renderGeneratedImage } from "../images.ts";
import type { BashExecutor } from "../tools/index.ts";
import { StreamingView } from "./streaming-view.ts";

const { bold, cyan, dim, gray, green, red, yellow } = styles;

export interface InteractiveOptions {
	client: ModelClient;
	config: AgentConfig;
	state: AgentState;
	session: Session;
	bash: BashExecutor;
	cwd: string;
	/** Rebuilds the system prompt for a model, so /model keeps it accurate. */
	systemPromptFor?: (model: string) => string;
	/** Prompt to run immediately on startup. */
	initialPrompt?: string;
	/**
	 * Vertex AI location from the file config (`--location` / config.json).
	 * Used as a fallback when switching to gcloud from a session that started
	 * in antigravity mode, where no vertexLocation has been established yet.
	 */
	configuredLocation?: string;
}

/** Status line shown under the editor. */
class StatusBar implements Component {
	text = "";

	render(width: number): string[] {
		return this.text ? [truncateToWidth(dim(this.text), width)] : [];
	}
}

/** Live view of the tools running in the current turn. */
class ToolStatus implements Component {
	private readonly active = new Map<string, { summary: string; startedAt: number }>();

	start(id: string, summary: string): void {
		this.active.set(id, { summary, startedAt: Date.now() });
	}

	end(id: string): void {
		this.active.delete(id);
	}

	clear(): void {
		this.active.clear();
	}

	render(width: number): string[] {
		return [...this.active.values()].map((entry) => {
			const seconds = Math.floor((Date.now() - entry.startedAt) / 1000);
			// Elapsed time is the signal that a long tool is still running.
			const elapsed = seconds > 0 ? dim(`  ${seconds}s`) : "";
			return truncateToWidth(`${yellow("●")} ${dim(entry.summary)}${elapsed}`, width);
		});
	}
}

const HELP = `Commands
  /help              show this help
  /model [id]        show or switch the model
  /models [refresh|check]  list models; 'check' probes each and hides failures
  /clear             start a new conversation
  /compact           summarize earlier history to free context
  /cost              show token usage and estimated cost
  /tools             list available tools
  /cwd               show the shell working directory
  /engine [mode]     switch engine; no arg opens a picker (gcloud | antigravity)
  /location [region] show or switch the Vertex region
  /exit              quit

Keys
  enter              send
  shift+enter        newline (or end the line with \\)
  esc                interrupt the current turn
  ctrl+c             clear input, twice to quit
  ctrl+d             quit
  up / down          input history`;

/** Run the interactive terminal UI until the user exits. */
export async function runInteractive(options: InteractiveOptions): Promise<number> {
	const { config, state, session, bash, cwd } = options;
	// Reassigned by /location: the region is fixed at client construction.
	let client = options.client;
	// The engines expose different model ids, so remember the model each was last
	// using; returning to an engine restores its model instead of discarding it.
	const modelByEngine = new Map<EngineMode, string>();
	// The region is bound at client construction and lost while in antigravity
	// mode, so remember it: returning to gcloud must restore the chosen region
	// rather than snapping back to the default. When starting in antigravity
	// mode, seed from the file config so the first switch to gcloud honours the
	// configured location rather than falling back to the hardcoded default.
	let vertexLocation =
		options.client instanceof VertexClient ? options.client.credentials.location : options.configuredLocation;
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const streaming = new StreamingView((lines) => tui.addStatic(lines));
	// Reasoning is streamed dim, above the answer it precedes.
	const thinking = new StreamingView((lines) => tui.addStatic(lines), dim);
	const toolStatus = new ToolStatus();
	const loader = new Loader({ label: "Thinking", onFrame: () => tui.requestRender() });
	const status = new StatusBar();
	const overlay = new Container();

	let busy = false;
	let abortController: AbortController | undefined;
	let lastCtrlC = 0;
	let exitCode = 0;
	const queued: string[] = [];
	// A prompt that hit the model's quota and is waiting for the reset window.
	let pendingRetry: { prompt: string; timer: ReturnType<typeof setTimeout> } | undefined;
	const cancelPendingRetry = () => {
		if (!pendingRetry) return;
		clearTimeout(pendingRetry.timer);
		pendingRetry = undefined;
	};

	let signalExit: () => void = () => {};
	const exited = new Promise<void>((resolvePromise) => {
		signalExit = resolvePromise;
	});
	/** Tear down the TUI and release the run loop. */
	const exit = (code: number) => {
		exitCode = code;
		cancelPendingRetry();
		tui.stop();
		signalExit();
	};

	const editor = new Editor({
		prompt: cyan("❯ "),
		placeholder: "Ask anything, or /help for commands",
		placeholderStyle: dim,
		onSubmit: (text) => {
			void handleSubmit(text);
		},
	});

	const updateStatus = () => {
		const usage = state.totalUsage;
		const tokens = usage.input + usage.output;
		const parts = [config.model];
		if (client instanceof VertexClient) {
			parts.push(`${client.credentials.project}/${client.credentials.location}`);
		} else {
			parts.push("antigravity");
		}
		parts.push(`${(tokens / 1000).toFixed(1)}k tokens`);
		const context = contextUsage(state, config.model);
		if (context > 0) parts.push(`${Math.round(context * 100)}% ctx`);
		if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
		status.text = parts.join(" · ");
	};

	tui.root.add(thinking, streaming, toolStatus, loader, editor, status, overlay);
	updateStatus();

	/** Write a block of lines into scrollback with a blank line after it. */
	const emit = (lines: string[]) => {
		tui.addStatic([...lines, ""]);
	};

	const emitError = (message: string) => {
		emit(renderMarkdown(message, terminal.columns).map((line) => red(line)));
	};

	const showOverlay = (component: Component) => {
		overlay.clear();
		overlay.add(component);
		tui.setFocus(component);
		tui.requestRender();
	};

	const closeOverlay = () => {
		overlay.clear();
		tui.setFocus(editor);
		tui.requestRender();
	};

	const chooseModel = async (onChosen: (id: string) => void = setModel) => {
		if (!client.catalog && client instanceof VertexClient) {
			emit([dim("Discovering models…")]);
			try {
				client.catalog = await loadCatalog(client.credentials);
			} catch (error) {
				emitError(`Could not list models: ${(error as Error).message}`);
				return;
			}
		}
		if (!client.catalog) {
			emitError("No models available.");
			return;
		}

		// Model Garden lists models the project cannot actually call, and an
		// unreleased id often outranks the one that works, hiding it. Verify
		// unchecked candidates with a real request so the list reflects access
		// rather than what the catalog advertises.
		if (client instanceof VertexClient) {
			const unchecked = conversationalModels(client.catalog).filter((entry) => entry.checkedAt === undefined);
			if (unchecked.length > 0) {
				if (busy) {
					emit([yellow("Finish or interrupt the current turn first (esc).")]);
					return;
				}
				busy = true;
				abortController = new AbortController();
				const signal = abortController.signal;
				loader.begin(`Checking 0/${unchecked.length} models`);
				tui.requestRender();
				try {
					const results = await probeModels(client, unchecked, {
						signal,
						onResult: (_result, done, total) => {
							loader.begin(`Checking ${done}/${total} models`);
							tui.requestRender();
						},
					});
					// An aborted run reports the unfinished models as failures; do not
					// persist that, or esc would silently mark models unavailable.
					if (!signal.aborted) {
						const checked = { ...client.catalog, entries: applyProbeResults(client.catalog.entries, results) };
						saveCatalog(checked);
						client.catalog = checked;
					}
				} catch (error) {
					emitError(`Model check failed: ${(error as Error).message}`);
				} finally {
					loader.stop();
					busy = false;
					abortController = undefined;
					tui.requestRender();
				}
			}
		}

		const entries: CatalogEntry[] = supportedModels(client.catalog);
		if (entries.length === 0) {
			emitError("No models available.");
			return;
		}
		const items: SelectItem<string>[] = entries.map((entry) => ({
			label: entry.id,
			description: entry.publisher,
			value: entry.id,
		}));
		showOverlay(
			new SelectList<string>({
				title: "Select a model",
				items,
				onSelect: (item) => {
					closeOverlay();
					onChosen(item.value);
				},
				onCancel: closeOverlay,
			}),
		);
	};

	/**
	 * Point the session at a model without persisting it, rejecting ids jtui
	 * cannot route. Returns whether the model was applied.
	 */
	const applyModel = (id: string): boolean => {
		try {
			client.resolveApi(id);
		} catch (error) {
			if (error instanceof UnsupportedModelError) {
				emitError([error.message, ...error.hints].join("\n"));
				return false;
			}
			throw error;
		}
		config.model = id;
		// The prompt names the model; leaving it stale makes the agent
		// misreport what it is.
		const prompt = options.systemPromptFor?.(id);
		if (prompt) config.systemPrompt = prompt;
		updateStatus();
		return true;
	};

	/** Switch models on an explicit /model choice, persisting the selection. */
	const setModel = (id: string) => {
		if (!applyModel(id)) return;

		// Remember the choice, so the next run starts on the same model rather
		// than falling back to whatever the default picker prefers.
		try {
			saveGlobalConfig({ model: id });
			emit([green(`Model set to ${id}`), dim("Saved as your default for future sessions.")]);
		} catch (error) {
			emit([green(`Model set to ${id}`), yellow(`Could not save it as the default: ${(error as Error).message}`)]);
		}
	};

	/** Present the engines as an arrow-key list, mirroring /model. */
	const chooseEngine = (onChosen: (mode: EngineMode) => void = (mode) => void setEngine(mode)) => {
		const current = client instanceof VertexClient ? "gcloud" : "antigravity";
		const items: SelectItem<EngineMode>[] = (
			[
				{ label: "gcloud", description: "direct Vertex AI", value: "gcloud" },
				{ label: "antigravity", description: "route through the Antigravity CLI", value: "antigravity" },
			] satisfies SelectItem<EngineMode>[]
		).map((item) => (item.value === current ? { ...item, label: `${item.label} (current)` } : item));
		showOverlay(
			new SelectList<EngineMode>({
				title: "Select an engine",
				items,
				onSelect: (item) => {
					closeOverlay();
					onChosen(item.value);
				},
				onCancel: closeOverlay,
			}),
		);
	};

	/** Switch engines, rebuilding the client and rediscovering its catalog. */
	const setEngine = async (mode: EngineMode): Promise<void> => {
		const current = client instanceof VertexClient ? "gcloud" : "antigravity";
		if (mode === current) {
			emit([dim(`Already using ${mode}.`)]);
			return;
		}
		if (busy) {
			emit([yellow("Finish or interrupt the current turn first (esc).")]);
			return;
		}

		// Remember what this engine was using so returning to it restores the
		// model rather than falling back to the default picker.
		modelByEngine.set(current, config.model);

		if (mode === "antigravity") {
			const cliPath = findAntigravityCli();
			if (!cliPath) {
				const error = new AntigravityCliNotFoundError();
				emitError([error.message, ...error.hints].join("\n"));
				return;
			}
			emit([dim("Discovering models via the Antigravity CLI…")]);
			try {
				const catalog = await discoverAntigravityModels(cliPath);
				client = new AntigravityClient(cliPath, { catalog, pricing: client.pricing });
			} catch (error) {
				emitError(`Could not switch to antigravity: ${(error as Error).message}`);
				return;
			}
		} else {
			emit([dim("Verifying Google Cloud credentials…")]);
			try {
				const credentials = await verifyCredentials(vertexLocation ? { location: vertexLocation } : {});
				const catalog = await loadCatalog(credentials);
				client = new VertexClient(credentials, { catalog, pricing: client.pricing });
				vertexLocation = credentials.location;
			} catch (error) {
				if (error instanceof VertexAuthError) {
					emitError([error.message, ...error.hints].join("\n"));
				} else {
					emitError(`Could not switch to gcloud: ${(error as Error).message}`);
				}
				return;
			}
		}

		updateStatus();
		emit([green(`Engine switched to ${mode}`)]);

		try {
			saveGlobalConfig({ engine: mode });
			emit([dim("Saved as your default for future sessions.")]);
		} catch (error) {
			emit([yellow(`Could not save the default: ${(error as Error).message}`)]);
		}

		// The engines have different catalogs, so a model valid under one may be
		// unknown to the other. Prefer the model this engine last used, keep the
		// current one if the engine knows it, and only fall back to the default
		// picker when neither is available. Auto-switches are not persisted, so a
		// detour through another engine never overwrites the saved default.
		// Match the model selector: a model the catalog lists but a check proved
		// uncallable (e.g. an anthropic id in a region that cannot serve it) must
		// not count as known, or switching engines back would reapply a model
		// whose next turn 400s.
		const callable = client.catalog ? new Set(callableModels(client.catalog).map((entry) => entry.id)) : undefined;
		const known = (id: string | undefined): id is string =>
			id !== undefined && (callable === undefined || callable.has(id));

		const remembered = modelByEngine.get(mode);
		if (known(remembered) && remembered !== config.model) {
			applyModel(remembered);
			return;
		}
		if (known(config.model)) return;

		const ids = client.catalog ? supportedModels(client.catalog).map((entry) => entry.id) : [];
		const fallback = pickDefaultModel(ids);
		if (fallback) {
			emit([yellow(`${config.model} is not available in this engine; switching to ${fallback}.`)]);
			applyModel(fallback);
		} else {
			emit([yellow(`${config.model} is not available in this engine.`), dim("  Pick another with /model.")]);
		}
	};

	/**
	 * Switch Vertex region. Both API clients bind the region when constructed,
	 * so this rebuilds the client and rediscovers models for the new region.
	 */
	const setLocation = async (location: string) => {
		if (!(client instanceof VertexClient)) {
			emit([yellow("Region switching is not available in antigravity mode.")]);
			return;
		}
		if (busy) {
			emit([yellow("Finish or interrupt the current turn first (esc).")]);
			return;
		}
		if (location === client.credentials.location) {
			emit([dim(`Already using ${location}.`)]);
			return;
		}

		emit([dim(`Switching to ${location}…`)]);
		const credentials = { ...client.credentials, location };
		try {
			const catalog = await loadCatalog(credentials);
			client = new VertexClient(credentials, { catalog, pricing: client.pricing });
		} catch (error) {
			emitError(`Could not switch to "${location}": ${(error as Error).message}`);
			return;
		}
		vertexLocation = location;

		// Refresh the status text before emitting: emit triggers the render that
		// paints it, so updating afterwards leaves the bar a frame stale.
		updateStatus();
		emit([green(`Location set to ${location}`)]);
		try {
			saveGlobalConfig({ location });
			emit([dim("Saved as your default for future sessions.")]);
		} catch (error) {
			emit([yellow(`Could not save it as the default: ${(error as Error).message}`)]);
		}

		// The model may not be published in the new region; say so rather than
		// letting the next turn fail with a raw 404.
		const available = client.catalog ? supportedModels(client.catalog) : [];
		if (available.length > 0 && !available.some((entry) => entry.id === config.model)) {
			emit([
				yellow(`${config.model} is not listed in ${location}.`),
				dim("  Pick another with /model, or switch back."),
			]);
		}
	};

	/** Returns true when the input was handled as a command. */
	const handleCommand = async (input: string): Promise<boolean> => {
		if (!input.startsWith("/")) return false;
		const [command, ...rest] = input.slice(1).split(/\s+/);
		const argument = rest.join(" ").trim();

		switch (command) {
			case "help":
				emit(HELP.split("\n").map((line) => dim(line)));
				return true;
			case "exit":
			case "quit":
				exit(0);
				return true;
			case "clear":
				state.messages.length = 0;
				streaming.reset();
				emit([green("Started a new conversation.")]);
				updateStatus();
				return true;
			case "cost": {
				const usage = state.totalUsage;
				emit([
					bold("Usage"),
					`  input      ${usage.input.toLocaleString()}`,
					`  output     ${usage.output.toLocaleString()}`,
					`  thinking   ${usage.thinking.toLocaleString()}`,
					`  cached     ${usage.cacheRead.toLocaleString()}`,
					usage.costUsd > 0
						? `  estimated  $${usage.costUsd.toFixed(4)}`
						: `  estimated  unknown — add a "pricing" entry for ${config.model} in .jtui/config.json`,
					dim("  jtui ships no rates; Vertex bills your project's own pricing."),
				]);
				return true;
			}
			case "tools":
				emit([
					bold("Tools"),
					...config.tools.map((tool) => `  ${cyan(tool.name)}  ${dim(tool.description.split(". ")[0] ?? "")}`),
				]);
				return true;
			case "cwd":
				emit([`Shell working directory: ${bash.cwd}`]);
				return true;
			case "compact": {
				if (busy) {
					emit([yellow("Finish or interrupt the current turn first (esc).")]);
					return true;
				}
				emit([dim("Compacting…")]);
				try {
					const result = await compact(client, config.model, state, config.compaction || undefined);
					if (result) {
						session.recordCompaction(state, result.removed);
						updateStatus();
						emit([green(`Compacted ${result.removed} earlier messages into a summary.`)]);
					} else {
						emit([dim("Not enough history to compact yet.")]);
					}
				} catch (error) {
					emitError(`Compaction failed: ${(error as Error).message}`);
				}
				session.sync(state);
				return true;
			}
			case "engine": {
				if (!argument) {
					chooseEngine();
					return true;
				}
				if (argument !== "gcloud" && argument !== "antigravity") {
					emitError(`Engine must be "gcloud" or "antigravity" (got "${argument}").`);
					return true;
				}
				await setEngine(argument);
				return true;
			}
			case "location":
				if (!(client instanceof VertexClient)) {
					emit([yellow("Region switching is not available in antigravity mode.")]);
					return true;
				}
				if (!argument) {
					emit([
						`Vertex region: ${client.credentials.location}`,
						dim("  /location <region> to switch, e.g. global, us-central1, us-east5"),
					]);
					return true;
				}
				await setLocation(argument);
				return true;
			case "model":
				if (!argument) {
					await chooseModel();
					return true;
				}
				setModel(argument);
				return true;
			case "models": {
				const check = argument === "check";
				if (client instanceof VertexClient) {
					emit([dim("Querying Vertex AI…")]);
					try {
						client.catalog = await loadCatalog(client.credentials, { refresh: argument === "refresh" });
					} catch (error) {
						emitError(`Could not list models: ${(error as Error).message}`);
						return true;
					}
				} else {
					if (check) {
						emit([yellow("Model checking is not available in antigravity mode.")]);
						return true;
					}
					emit([dim("Using cached model list.")]);
				}
				if (check && client instanceof VertexClient && client.catalog) {
					if (busy) {
						emit([yellow("Finish or interrupt the current turn first (esc).")]);
						return true;
					}
					// Probing fires a real request per model, so guard it like a turn:
					// esc aborts, and other input queues rather than overlapping.
					const targets = adapterModels(client.catalog);
					busy = true;
					abortController = new AbortController();
					const signal = abortController.signal;
					loader.begin(`Checking 0/${targets.length} models`);
					tui.requestRender();
					try {
						const results = await probeModels(client, targets, {
							signal,
							onResult: (_result, done, total) => {
								loader.begin(`Checking ${done}/${total} models`);
								tui.requestRender();
							},
						});
						// An aborted run reports the unfinished models as failures; do not
						// persist that, or esc would silently mark models unavailable.
						if (signal.aborted) {
							emit([yellow("Check interrupted; catalog unchanged.")]);
						} else {
							const checked = { ...client.catalog, entries: applyProbeResults(client.catalog.entries, results) };
							saveCatalog(checked);
							client.catalog = checked;
							const failed = results.filter((result) => !result.available).length;
							emit([green(`Checked ${results.length} model(s); ${failed} unavailable and now hidden.`)]);
						}
					} catch (error) {
						emitError(`Model check failed: ${(error as Error).message}`);
					} finally {
						loader.stop();
						busy = false;
						abortController = undefined;
						tui.requestRender();
					}
				}
				const catalog = client.catalog;
				if (!catalog) {
					emitError("No model catalog available.");
					return true;
				}
				const rows: string[] = [];
				let publisher = "";
				for (const entry of supportedModels(catalog)) {
					if (entry.publisher !== publisher) {
						publisher = entry.publisher;
						rows.push(bold(publisher));
					}
					rows.push(entry.id === config.model ? cyan(`  ${entry.id}  (current)`) : `  ${entry.id}`);
				}
				emit([...rows, dim("  /models check probes each model; refresh re-queries Model Garden.")]);
				return true;
			}
			default:
				emitError(`Unknown command: /${command}. Try /help.`);
				return true;
		}
	};

	const renderToolResult = (execution: ToolExecution): string[] => {
		const { toolCall, output, durationMs } = execution;
		const marker = output.isError ? red("✗") : green("●");
		const header = `${marker} ${bold(toolCall.name)} ${dim(`${durationMs}ms`)}`;
		const text = typeof output.content === "string" ? output.content : "";
		const lines = text.split("\n").filter((line) => line.length > 0);
		const preview = lines.slice(0, output.isError ? 8 : 4);
		const more = lines.length - preview.length;
		return [
			header,
			...preview.map((line) => gray(`  ${truncateToWidth(line, Math.max(20, terminal.columns - 4))}`)),
			...(more > 0 ? [dim(`  … ${more} more lines`)] : []),
		];
	};

	/** Queue a prompt to re-run automatically once the quota window elapses. */
	const scheduleRetry = (prompt: string, delayMs: number) => {
		cancelPendingRetry();
		const timer = setTimeout(() => {
			pendingRetry = undefined;
			emit([green("Quota should be back — retrying your queued prompt.")]);
			void handleSubmit(prompt);
		}, delayMs);
		pendingRetry = { prompt, timer };
		emit([
			yellow(`Model quota exhausted. Queued your prompt; retrying automatically in ${formatDuration(delayMs)}.`),
			dim("  Or choose an option below to run it now on another model or engine."),
		]);
	};

	/** Cancel the auto-retry, pick a new model on this engine, and run the prompt now. */
	const retryOnAnotherModel = (prompt: string) => {
		cancelPendingRetry();
		void chooseModel((id) => {
			setModel(id);
			void handleSubmit(prompt);
		});
	};

	/** Cancel the auto-retry, switch engine and model, and run the prompt now. */
	const retryOnAnotherEngine = (prompt: string) => {
		cancelPendingRetry();
		chooseEngine(async (mode) => {
			await setEngine(mode);
			void chooseModel((id) => {
				setModel(id);
				void handleSubmit(prompt);
			});
		});
	};

	/**
	 * A model quota is exhausted. Queue the prompt for automatic retry (the
	 * default), and offer to run it now on another model or engine instead.
	 */
	const offerQuotaRetry = (prompt: string, resetMs: number | undefined) => {
		// A known reset window lets us queue an automatic retry as the default.
		// Without one (the CLI does not always report it), the only recourse is to
		// switch pool, model, or engine now.
		if (resetMs !== undefined) {
			scheduleRetry(prompt, resetMs);
		} else {
			emit([
				yellow("Model quota exhausted, with no reset time reported."),
				dim("  Choose an option below to run your prompt now."),
			]);
		}
		const items = [
			...(resetMs !== undefined
				? [
						{
							label: `Wait ${formatDuration(resetMs)} and retry automatically`,
							description: "recommended",
							value: "wait",
						},
					]
				: []),
			{ label: "Retry now on another model", description: "same engine", value: "model" },
			{ label: "Retry now on another engine and model", value: "engine" },
		];
		showOverlay(
			new SelectList<string>({
				title: "Model quota exhausted",
				items,
				onSelect: (item) => {
					closeOverlay();
					if (item.value === "wait") return;
					if (item.value === "model") retryOnAnotherModel(prompt);
					else retryOnAnotherEngine(prompt);
				},
				// Cancelling keeps the scheduled auto-retry, if any.
				onCancel: closeOverlay,
			}),
		);
	};

	const runTurn = async (prompt: string): Promise<void> => {
		busy = true;
		abortController = new AbortController();
		loader.begin("Thinking");
		const turnStartedAt = Date.now();
		// Set when the turn fails with a quota-exhausted error; drives the retry flow.
		// The reset delay may be unknown even when the quota is exhausted.
		let quotaExhausted = false;
		let quotaResetMs: number | undefined;
		tui.requestRender();

		// Commit any streamed reasoning to scrollback, with a blank line to set
		// it off from whatever follows (an answer or a tool result).
		const flushThinking = () => {
			if (thinking.isEmpty) return;
			thinking.finish(terminal.columns);
			tui.addStatic([""]);
		};

		try {
			for await (const event of runAgent(client, config, state, prompt, abortController.signal)) {
				switch (event.type) {
					case "text_delta":
						loader.stop();
						flushThinking();
						streaming.append(event.delta);
						break;
					case "thinking_delta":
						loader.stop();
						thinking.append(event.delta);
						break;
					case "status":
						// A quiet working phase (e.g. the Antigravity CLI running a tool
						// internally). Keep the spinner animating with a live label so the
						// screen never looks frozen.
						loader.begin(event.label);
						break;
					case "image": {
						loader.stop();
						flushThinking();
						// Commit any streamed text first so the image lands in order.
						streaming.finish(terminal.columns);
						tui.addStatic([
							...renderGeneratedImage(event.image, {
								cwd: options.cwd,
								columns: terminal.columns,
								rows: terminal.rows,
							}),
							"",
						]);
						break;
					}
					case "assistant_message":
						streaming.finish(terminal.columns);
						if (messageText(event.message).trim().length > 0) tui.addStatic([""]);
						session.sync(state);
						updateStatus();
						break;
					case "tool_start":
						// A turn may reason and then call a tool without any answer
						// text, so commit that reasoning before the tool result lands.
						flushThinking();
						// Keep animating: the tool run is the longest, quietest part
						// of a turn, and a frozen screen reads as a hang.
						loader.begin(event.summary);
						toolStatus.start(event.toolCall.id, event.summary);
						break;
					case "tool_end":
						toolStatus.end(event.execution.toolCall.id);
						emit(renderToolResult(event.execution));
						loader.begin("Thinking");
						break;
					case "compaction_start":
						loader.begin("Compacting context");
						break;
					case "compacted":
						// Record the rewrite now; waiting until the next sync would log
						// the messages that follow at the wrong offsets.
						session.recordCompaction(state, event.removed);
						emit([dim(`Compacted ${event.removed} earlier messages into a summary.`)]);
						updateStatus();
						break;
					case "loop_detected": {
						const preview = event.repeatedUnit.split("\n")[0]?.slice(0, 70) ?? "";
						emit([
							yellow("Stopped: the model was repeating itself."),
							dim(`  repeated: ${preview}`),
							dim("  Rephrase, or try another model with /model."),
						]);
						break;
					}
					case "error": {
						quotaExhausted = isQuotaExhausted(event.message);
						quotaResetMs = parseQuotaReset(event.message);
						// A quota error is handled by the retry flow after the turn ends,
						// so it is not surfaced as a hard error here.
						if (!quotaExhausted) emitError(event.message);
						break;
					}
					case "turn_end": {
						if (event.reason === "aborted") emit([yellow("Interrupted.")]);
						const seconds = (Date.now() - turnStartedAt) / 1000;
						// Says "finished" rather than leaving the user guessing whether
						// a quiet screen means working or done.
						if (seconds >= 2) emit([dim(`— done in ${seconds.toFixed(1)}s`)]);
						break;
					}
				}
				tui.requestRender();
			}
		} catch (error) {
			emitError(`Agent failed: ${(error as Error).message}`);
		} finally {
			loader.stop();
			toolStatus.clear();
			flushThinking();
			streaming.finish(terminal.columns);
			session.sync(state);
			busy = false;
			abortController = undefined;
			updateStatus();
			tui.requestRender();
		}

		if (quotaExhausted) {
			// Hold the queue until the retry runs; the queued prompts would only hit
			// the same exhausted quota now.
			offerQuotaRetry(prompt, quotaResetMs);
			return;
		}
		const next = queued.shift();
		if (next !== undefined) await handleSubmit(next);
	};

	async function handleSubmit(text: string): Promise<void> {
		const input = text.trim();
		if (input.length === 0) return;
		if (busy) {
			// Keep the input rather than dropping it; it runs after this turn.
			queued.push(input);
			emit([dim(`Queued: ${truncateToWidth(input, terminal.columns - 10)}`)]);
			return;
		}
		emit(renderMarkdown(input, terminal.columns).map((line) => `${cyan("❯")} ${line}`));
		if (await handleCommand(input)) return;
		await runTurn(input);
	}

	tui.onKey((key) => {
		if (key.name === "c" && key.ctrl) {
			if (busy) {
				abortController?.abort();
				return true;
			}
			if (editor.getText().length > 0) {
				editor.clear();
				return true;
			}
			const now = Date.now();
			if (now - lastCtrlC < 2000) {
				exit(130);
				return true;
			}
			lastCtrlC = now;
			status.text = "Press ctrl+c again to exit";
			return true;
		}
		if (key.name === "d" && key.ctrl && editor.getText().length === 0 && !busy) {
			exit(0);
			return true;
		}
		if (key.name === "escape" && busy) {
			abortController?.abort();
			return true;
		}
		return false;
	});

	printBanner(client, config, cwd);
	tui.start();
	tui.setFocus(editor);

	if (options.initialPrompt) await handleSubmit(options.initialPrompt);

	await exited;

	session.sync(state);
	return exitCode;
}

/**
 * Extract the retry delay from a quota-exhausted error, in milliseconds.
 *
 * The Antigravity CLI reports these as free text, e.g. "You have exhausted your
 * capacity on this model. Your quota will reset after 10m10s." Returns undefined
 * for any other error so the caller can fall back to surfacing it normally.
 */
export function isQuotaExhausted(message: string): boolean {
	return /exhausted (?:your )?capacity|quota will reset/i.test(message);
}

export function parseQuotaReset(message: string): number | undefined {
	if (!isQuotaExhausted(message)) return undefined;
	const match = /reset (?:after|in) ((?:\d+h)?(?:\d+m)?(?:\d+s)?)/i.exec(message);
	const spec = match?.[1];
	if (!spec) return undefined;
	const hours = /(\d+)h/.exec(spec);
	const minutes = /(\d+)m/.exec(spec);
	const seconds = /(\d+)s/.exec(spec);
	const total =
		(hours ? Number(hours[1]) : 0) * 3600 +
		(minutes ? Number(minutes[1]) : 0) * 60 +
		(seconds ? Number(seconds[1]) : 0);
	return total > 0 ? total * 1000 : undefined;
}

/** Render a millisecond duration as a compact "1h2m3s" string. */
function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const parts: string[] = [];
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (seconds || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join("");
}

function printBanner(client: ModelClient, config: AgentConfig, cwd: string): void {
	const entry = client.entryFor(config.model);
	const publisher = entry ? ` (${entry.publisher})` : "";
	const subtitle =
		client instanceof VertexClient ? "coding agent on Google Cloud Vertex AI" : "coding agent via Antigravity";
	const lines = [`${bold(cyan("jtui"))} ${dim(`· ${subtitle}`)}`, dim(`  model    ${config.model}${publisher}`)];
	if (client instanceof VertexClient) {
		lines.push(dim(`  project  ${client.credentials.project}`));
		lines.push(dim(`  location ${client.credentials.location}`));
	} else {
		lines.push(dim("  engine   antigravity (Antigravity CLI)"));
	}
	lines.push(dim(`  cwd      ${cwd}`), "", dim("  /help for commands, esc to interrupt"), "");
	process.stdout.write(`${lines.join("\n")}\n`);
}
