import { spawn } from "node:child_process";
import type { AgentTool, ToolContext, ToolOutput } from "@jtui/agent";
import { truncateOutput } from "./common.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Sentinel used to read the shell's working directory back after each command. */
const CWD_MARKER = "__JTUI_CWD__";

interface BashArgs {
	command: string;
	timeout_ms?: number;
	description?: string;
}

/**
 * Shell tool with a working directory that persists across calls.
 *
 * Each command runs in its own shell, so `cd` would normally be forgotten. The
 * executor appends a marker that echoes `$PWD`, reads it back, and uses it as
 * the cwd for the next command.
 */
export class BashExecutor {
	cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async run(command: string, timeoutMs: number, context: ToolContext): Promise<ToolOutput> {
		const wrapped = `${command}\nprintf '\\n${CWD_MARKER}%s' "$PWD"`;
		return new Promise<ToolOutput>((resolve) => {
			const child = spawn("bash", ["-c", wrapped], {
				cwd: this.cwd,
				env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
				// Own process group, so a timeout can kill the command's children
				// too. Without this, a grandchild keeps the stdio pipes open and
				// the close event never fires.
				detached: process.platform !== "win32",
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			/** Kill the whole process group, falling back to the shell itself. */
			const kill = () => {
				if (child.pid === undefined) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone, or the group no longer exists.
					child.kill("SIGKILL");
				}
			};

			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, timeoutMs);

			const onAbort = () => {
				kill();
			};
			context.signal.addEventListener("abort", onAbort, { once: true });

			child.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				stdout += text;
				context.onProgress?.(text);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				stderr += text;
				context.onProgress?.(text);
			});

			child.on("error", (error) => {
				clearTimeout(timer);
				context.signal.removeEventListener("abort", onAbort);
				resolve({ content: `Failed to run command: ${error.message}`, isError: true });
			});

			child.on("close", (code) => {
				clearTimeout(timer);
				context.signal.removeEventListener("abort", onAbort);

				// Split the cwd marker back out of stdout.
				const markerIndex = stdout.lastIndexOf(CWD_MARKER);
				if (markerIndex !== -1) {
					const reported = stdout.slice(markerIndex + CWD_MARKER.length).trim();
					if (reported) this.cwd = reported;
					stdout = stdout.slice(0, markerIndex).replace(/\n$/, "");
				}

				if (context.signal.aborted) {
					resolve({ content: "Command was interrupted by the user.", isError: true });
					return;
				}
				if (timedOut) {
					resolve({
						content: truncateOutput(`Command timed out after ${timeoutMs}ms.\n${stdout}${stderr}`),
						isError: true,
					});
					return;
				}

				const sections: string[] = [];
				if (stdout.trim()) sections.push(stdout.trimEnd());
				if (stderr.trim()) sections.push(`stderr:\n${stderr.trimEnd()}`);
				if (code !== 0) sections.push(`Exit code: ${code}`);
				const content = sections.join("\n\n");
				resolve({
					content: truncateOutput(content || "(no output)"),
					isError: code !== 0,
					details: { exitCode: code, cwd: this.cwd },
				});
			});
		});
	}
}

/** Build the bash tool bound to a persistent executor. */
export function createBashTool(executor: BashExecutor): AgentTool<BashArgs> {
	return {
		name: "bash",
		description:
			"Run a shell command with bash. The working directory persists between calls, so `cd` works as expected. " +
			"Use this for builds, tests, git and anything not covered by the file tools. " +
			"Avoid interactive commands; they will hang until the timeout.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
				timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 120000, max 600000." },
				description: { type: "string", description: "Short description of what the command does." },
			},
			required: ["command"],
		},
		summarize: (args) => args.description ?? args.command.split("\n")[0]?.slice(0, 60) ?? "bash",
		execute: (args, context) =>
			executor.run(args.command, Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS), context),
	};
}
