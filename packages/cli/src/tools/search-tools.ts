import { spawn } from "node:child_process";
import { glob, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { AgentTool } from "@jtui/agent";
import { resolvePath, truncateOutput } from "./common.ts";

const IGNORED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/__pycache__/**", "**/.venv/**"];

interface GlobArgs {
	pattern: string;
	path?: string;
}

/** Find files by glob pattern, newest first. */
export const globTool: AgentTool<GlobArgs> = {
	name: "glob",
	description:
		'Find files matching a glob pattern, for example "src/**/*.ts". Results are sorted by modification time, ' +
		"newest first. Use this to locate files by name.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Glob pattern to match against file paths." },
			path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
		},
		required: ["pattern"],
	},
	summarize: (args) => `glob ${args.pattern}`,
	async execute(args, context) {
		const root = resolvePath(context.cwd, args.path ?? ".");
		const matches: string[] = [];
		try {
			for await (const entry of glob(args.pattern, { cwd: root, exclude: IGNORED })) {
				matches.push(typeof entry === "string" ? entry : String(entry));
				if (matches.length >= 1000) break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: `Glob failed: ${message}`, isError: true };
		}
		if (matches.length === 0) return { content: `No files matching "${args.pattern}".` };

		// Sort by mtime so the most recently touched files surface first.
		const withTimes = await Promise.all(
			matches.map(async (match) => ({
				match,
				mtime: await stat(resolvePath(root, match))
					.then((info) => info.mtimeMs)
					.catch(() => 0),
			})),
		);
		withTimes.sort((a, b) => b.mtime - a.mtime);
		return {
			content: truncateOutput(withTimes.map((entry) => entry.match).join("\n")),
			details: { count: matches.length },
		};
	},
};

interface GrepArgs {
	pattern: string;
	path?: string;
	glob?: string;
	case_insensitive?: boolean;
	max_results?: number;
}

/** Run ripgrep when present; it is far faster on large trees. */
async function ripgrep(args: GrepArgs, root: string, limit: number): Promise<string | undefined> {
	const parameters = ["--line-number", "--no-heading", "--color=never", `--max-count=${limit}`];
	if (args.case_insensitive) parameters.push("--ignore-case");
	if (args.glob) parameters.push("--glob", args.glob);
	parameters.push("--regexp", args.pattern, ".");

	return new Promise((resolvePromise) => {
		const child = spawn("rg", parameters, { cwd: root });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => resolvePromise(undefined));
		child.on("close", (code) => {
			// 0 = matches, 1 = no matches; anything else means rg failed.
			resolvePromise(code === 0 || code === 1 ? stdout : undefined);
		});
	});
}

/** Fallback scan in pure Node when ripgrep is unavailable. */
async function scanFiles(args: GrepArgs, root: string, limit: number): Promise<string> {
	const flags = args.case_insensitive ? "i" : "";
	const expression = new RegExp(args.pattern, flags);
	const results: string[] = [];
	for await (const entry of glob(args.glob ?? "**/*", { cwd: root, exclude: IGNORED })) {
		const path = resolvePath(root, typeof entry === "string" ? entry : String(entry));
		const info = await stat(path).catch(() => undefined);
		if (!info?.isFile() || info.size > 2_000_000) continue;
		const content = await readFile(path, "utf8").catch(() => undefined);
		if (content === undefined) continue;
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? "";
			if (!expression.test(line)) continue;
			results.push(`${relative(root, path)}:${index + 1}:${line.trim().slice(0, 300)}`);
			if (results.length >= limit) return results.join("\n");
		}
	}
	return results.join("\n");
}

/** Search file contents by regular expression. */
export const grepTool: AgentTool<GrepArgs> = {
	name: "grep",
	description:
		"Search file contents with a regular expression. Returns matching lines prefixed with file:line. " +
		"Use this to find where something is defined or used.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regular expression to search for." },
			path: { type: "string", description: "Directory to search. Defaults to the working directory." },
			glob: { type: "string", description: 'Restrict to files matching this glob, e.g. "*.ts".' },
			case_insensitive: { type: "boolean", description: "Ignore case when matching." },
			max_results: { type: "number", description: "Maximum matching lines to return. Defaults to 200." },
		},
		required: ["pattern"],
	},
	summarize: (args) => `grep ${args.pattern}`,
	async execute(args, context) {
		const root = resolvePath(context.cwd, args.path ?? ".");
		const limit = Math.max(1, args.max_results ?? 200);
		try {
			// Validate the pattern up front so bad regexes fail with a clear message.
			new RegExp(args.pattern);
		} catch (error) {
			return { content: `Invalid regular expression: ${(error as Error).message}`, isError: true };
		}

		const output = (await ripgrep(args, root, limit)) ?? (await scanFiles(args, root, limit));
		if (output.trim().length === 0) return { content: `No matches for "${args.pattern}".` };
		const lines = output.trimEnd().split("\n").slice(0, limit);
		return { content: truncateOutput(lines.join("\n")), details: { matches: lines.length } };
	},
};
