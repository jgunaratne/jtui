import { type AgentConfig, type AgentState, runAgent, type Session, type ToolExecution } from "@jtui/agent";
import {
	type CatalogEntry,
	loadCatalog,
	messageText,
	supportedModels,
	UnsupportedModelError,
	VertexClient,
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
import type { BashExecutor } from "../tools/index.ts";
import { StreamingView } from "./streaming-view.ts";

const { bold, cyan, dim, gray, green, red, yellow } = styles;

export interface InteractiveOptions {
	client: VertexClient;
	config: AgentConfig;
	state: AgentState;
	session: Session;
	bash: BashExecutor;
	cwd: string;
	/** Prompt to run immediately on startup. */
	initialPrompt?: string;
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
	private readonly active = new Map<string, string>();

	start(id: string, summary: string): void {
		this.active.set(id, summary);
	}

	end(id: string): void {
		this.active.delete(id);
	}

	clear(): void {
		this.active.clear();
	}

	render(width: number): string[] {
		return [...this.active.values()].map((summary) => truncateToWidth(`${yellow("●")} ${dim(summary)}`, width));
	}
}

const HELP = `Commands
  /help              show this help
  /model [id]        show or switch the model
  /models [refresh]  list models available to this project
  /clear             start a new conversation
  /cost              show token usage and estimated cost
  /tools             list available tools
  /cwd               show the shell working directory
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
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const streaming = new StreamingView((lines) => tui.addStatic(lines));
	const toolStatus = new ToolStatus();
	const loader = new Loader({ label: "Thinking", onFrame: () => tui.requestRender() });
	const status = new StatusBar();
	const overlay = new Container();

	let busy = false;
	let abortController: AbortController | undefined;
	let lastCtrlC = 0;
	let exitCode = 0;
	const queued: string[] = [];

	let signalExit: () => void = () => {};
	const exited = new Promise<void>((resolvePromise) => {
		signalExit = resolvePromise;
	});
	/** Tear down the TUI and release the run loop. */
	const exit = (code: number) => {
		exitCode = code;
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
		const parts = [
			config.model,
			`${client.credentials.project}/${client.credentials.location}`,
			`${(tokens / 1000).toFixed(1)}k tokens`,
		];
		if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
		status.text = parts.join(" · ");
	};

	tui.root.add(streaming, toolStatus, loader, editor, status, overlay);
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

	const chooseModel = async () => {
		let entries: CatalogEntry[] = client.catalog ? supportedModels(client.catalog) : [];
		if (entries.length === 0) {
			emit([dim("Discovering models…")]);
			try {
				client.catalog = await loadCatalog(client.credentials);
				entries = supportedModels(client.catalog);
			} catch (error) {
				emitError(`Could not list models: ${(error as Error).message}`);
				return;
			}
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
					setModel(item.value);
				},
				onCancel: closeOverlay,
			}),
		);
	};

	/** Switch models, rejecting ids jtui cannot route. */
	const setModel = (id: string) => {
		try {
			client.resolveApi(id);
		} catch (error) {
			if (error instanceof UnsupportedModelError) {
				emitError([error.message, ...error.hints].join("\n"));
				return;
			}
			throw error;
		}
		config.model = id;
		updateStatus();
		emit([green(`Model set to ${id}`)]);
	};

	/**
	 * Switch Vertex region. Both API clients bind the region when constructed,
	 * so this rebuilds the client and rediscovers models for the new region.
	 */
	const setLocation = async (location: string) => {
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

		// Refresh the status text before emitting: emit triggers the render that
		// paints it, so updating afterwards leaves the bar a frame stale.
		updateStatus();
		emit([green(`Location set to ${location}`)]);

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
			case "location":
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
				emit([dim("Querying Vertex AI…")]);
				try {
					client.catalog = await loadCatalog(client.credentials, { refresh: argument === "refresh" });
					const rows: string[] = [];
					let publisher = "";
					for (const entry of supportedModels(client.catalog)) {
						if (entry.publisher !== publisher) {
							publisher = entry.publisher;
							rows.push(bold(publisher));
						}
						rows.push(entry.id === config.model ? cyan(`  ${entry.id}  (current)`) : `  ${entry.id}`);
					}
					emit([...rows, dim("  /models refresh re-queries; access is granted in Model Garden.")]);
				} catch (error) {
					emitError(`Could not list models: ${(error as Error).message}`);
				}
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

	const runTurn = async (prompt: string): Promise<void> => {
		busy = true;
		abortController = new AbortController();
		loader.label = "Thinking";
		loader.start();
		tui.requestRender();

		try {
			for await (const event of runAgent(client, config, state, prompt, abortController.signal)) {
				switch (event.type) {
					case "text_delta":
						loader.stop();
						streaming.append(event.delta);
						break;
					case "thinking_delta":
						loader.label = "Thinking";
						break;
					case "assistant_message":
						streaming.finish(terminal.columns);
						if (messageText(event.message).trim().length > 0) tui.addStatic([""]);
						session.sync(state);
						updateStatus();
						break;
					case "tool_start":
						loader.stop();
						toolStatus.start(event.toolCall.id, event.summary);
						break;
					case "tool_end":
						toolStatus.end(event.execution.toolCall.id);
						emit(renderToolResult(event.execution));
						loader.label = "Thinking";
						loader.start();
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
					case "error":
						emitError(event.message);
						break;
					case "turn_end":
						if (event.reason === "aborted") emit([yellow("Interrupted.")]);
						break;
				}
				tui.requestRender();
			}
		} catch (error) {
			emitError(`Agent failed: ${(error as Error).message}`);
		} finally {
			loader.stop();
			toolStatus.clear();
			streaming.finish(terminal.columns);
			session.sync(state);
			busy = false;
			abortController = undefined;
			updateStatus();
			tui.requestRender();
			const next = queued.shift();
			if (next !== undefined) await handleSubmit(next);
		}
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

function printBanner(client: VertexClient, config: AgentConfig, cwd: string): void {
	const entry = client.entryFor(config.model);
	const publisher = entry ? ` (${entry.publisher})` : "";
	const lines = [
		`${bold(cyan("jtui"))} ${dim("· coding agent on Google Cloud Vertex AI")}`,
		dim(`  model    ${config.model}${publisher}`),
		dim(`  project  ${client.credentials.project}`),
		dim(`  location ${client.credentials.location}`),
		dim(`  cwd      ${cwd}`),
		"",
		dim("  /help for commands, esc to interrupt"),
		"",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}
