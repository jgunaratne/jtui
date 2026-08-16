import type { ThinkingLevel } from "@jtui/ai";

export interface ParsedArgs {
	command: "run" | "models" | "auth" | "sessions" | "help" | "version";
	prompt?: string;
	print: boolean;
	json: boolean;
	verbose: boolean;
	model?: string;
	project?: string;
	location?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	credentialsFile?: string;
	/** Resume the most recent session in this directory. */
	continueSession: boolean;
	/** Resume a specific session id. */
	resume?: string;
	noProjectContext: boolean;
	/** Re-query the model catalog instead of using the cache. */
	refresh: boolean;
	/** Include models jtui has no adapter for. */
	all: boolean;
	/** With 'models', send a real request to each one and record what answers. */
	check: boolean;
	/** Disable cutting a turn short when the model repeats itself. */
	noLoopDetection: boolean;
	/** Disable summarizing older history as the context fills. */
	noCompaction: boolean;
	errors: string[];
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "low", "medium", "high"]);

export const USAGE = `jtui - coding agent backed by Google Cloud Vertex AI

Usage
  jtui [options] [prompt]        start the interactive agent
  jtui -p [options] <prompt>     run once and print the answer
  jtui models [--all|--check]    list models available to the project
  jtui auth                      check Google Cloud credentials
  jtui sessions                  list saved sessions in this directory

Options
  -p, --print              non-interactive; write the answer to stdout
      --json               with --print, emit one JSON event per line
  -v, --verbose            report tool activity on stderr
  -m, --model <id>         model id (Gemini or Claude; see 'jtui models')
      --project <id>       Google Cloud project
      --location <region>  Vertex AI location (default: us-central1)
      --thinking <level>   off | low | medium | high (default: medium)
      --max-turns <n>      stop after n assistant turns (default: 100)
      --credentials <path> service account key file
  -c, --continue           resume the most recent session here
      --resume <id>        resume a specific session
      --no-project-context ignore JTUI.md / AGENTS.md / CLAUDE.md
      --refresh            re-query the model catalog instead of using the cache
      --all                with 'models', include publishers jtui cannot call
      --check              with 'models', call each one and hide what fails
      --no-loop-detection  do not stop a turn when the model repeats itself
      --no-compaction      do not summarize older history as the context fills
  -h, --help               show this help
      --version            show the version

Authentication
  jtui uses Application Default Credentials. Set them up once with:
    gcloud auth application-default login
    gcloud config set project YOUR_PROJECT_ID

  Or point GOOGLE_APPLICATION_CREDENTIALS at a service account key.

Environment
  GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, GOOGLE_APPLICATION_CREDENTIALS`;

/** Parse argv into options. Unknown flags are reported, not thrown. */
export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		command: "run",
		print: false,
		json: false,
		verbose: false,
		continueSession: false,
		noProjectContext: false,
		refresh: false,
		all: false,
		check: false,
		noLoopDetection: false,
		noCompaction: false,
		errors: [],
	};
	const positional: string[] = [];

	// A value-taking flag consumes the next argument.
	const next = (index: number, flag: string): string | undefined => {
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("-")) {
			args.errors.push(`${flag} requires a value`);
			return undefined;
		}
		return value;
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] ?? "";
		switch (argument) {
			case "-h":
			case "--help":
				args.command = "help";
				break;
			case "--version":
				args.command = "version";
				break;
			case "-p":
			case "--print":
				args.print = true;
				break;
			case "--json":
				args.json = true;
				args.print = true;
				break;
			case "-v":
			case "--verbose":
				args.verbose = true;
				break;
			case "-c":
			case "--continue":
				args.continueSession = true;
				break;
			case "--no-project-context":
				args.noProjectContext = true;
				break;
			case "--refresh":
				args.refresh = true;
				break;
			case "--all":
				args.all = true;
				break;
			case "--check":
				args.check = true;
				break;
			case "--no-loop-detection":
				args.noLoopDetection = true;
				break;
			case "--no-compaction":
				args.noCompaction = true;
				break;
			case "-m":
			case "--model":
				args.model = next(index, argument);
				index += 1;
				break;
			case "--project":
				args.project = next(index, argument);
				index += 1;
				break;
			case "--location":
				args.location = next(index, argument);
				index += 1;
				break;
			case "--credentials":
				args.credentialsFile = next(index, argument);
				index += 1;
				break;
			case "--resume":
				args.resume = next(index, argument);
				index += 1;
				break;
			case "--thinking": {
				const value = next(index, argument);
				index += 1;
				if (value === undefined) break;
				if (!THINKING_LEVELS.has(value as ThinkingLevel)) {
					args.errors.push(`--thinking must be one of: off, low, medium, high (got "${value}")`);
					break;
				}
				args.thinking = value as ThinkingLevel;
				break;
			}
			case "--max-turns": {
				const value = next(index, argument);
				index += 1;
				if (value === undefined) break;
				const parsed = Number.parseInt(value, 10);
				if (!Number.isFinite(parsed) || parsed < 1) {
					args.errors.push(`--max-turns must be a positive integer (got "${value}")`);
					break;
				}
				args.maxTurns = parsed;
				break;
			}
			default:
				if (argument.startsWith("-") && argument.length > 1) {
					args.errors.push(`unknown option: ${argument}`);
					break;
				}
				positional.push(argument);
		}
	}

	// The first positional may name a subcommand; anything else is the prompt.
	const first = positional[0];
	if (args.command === "run" && first && ["models", "auth", "sessions"].includes(first)) {
		args.command = first as ParsedArgs["command"];
		positional.shift();
	}
	if (positional.length > 0) args.prompt = positional.join(" ");
	if (args.print && !args.prompt) args.errors.push("--print requires a prompt");

	return args;
}
