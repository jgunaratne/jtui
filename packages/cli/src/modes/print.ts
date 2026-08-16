import type { AgentConfig, AgentState, Session } from "@jtui/agent";
import { runAgent } from "@jtui/agent";
import { type ModelClient, messageText } from "@jtui/ai";
import { renderGeneratedImage, saveImage } from "../images.ts";

export interface PrintOptions {
	client: ModelClient;
	config: AgentConfig;
	state: AgentState;
	session: Session;
	prompt: string;
	/** Where generated images are written. */
	cwd: string;
	/** Emit tool activity to stderr as it happens. */
	verbose?: boolean;
	/** Emit one JSON object per event to stdout instead of prose. */
	json?: boolean;
}

/**
 * Non-interactive run: stream the answer to stdout and exit.
 *
 * Prose goes to stdout so it can be piped; progress goes to stderr so it does
 * not pollute the output.
 */
export async function runPrint(options: PrintOptions): Promise<number> {
	const { client, config, state, session, prompt } = options;
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.on("SIGINT", onSigint);

	let failed = false;
	try {
		for await (const event of runAgent(client, config, state, prompt, controller.signal)) {
			if (options.json) {
				if (event.type === "image") {
					// Megabytes of base64 would drown the event stream; the file
					// on disk is what a consumer actually wants.
					const path = saveImage(event.image, options.cwd);
					const bytes = Buffer.from(event.image.data, "base64").length;
					process.stdout.write(`${JSON.stringify({ type: "image", mimeType: event.image.mimeType, path, bytes })}\n`);
					continue;
				}
				process.stdout.write(`${JSON.stringify(event)}\n`);
				if (event.type === "error") failed = true;
				continue;
			}
			switch (event.type) {
				case "text_delta":
					process.stdout.write(event.delta);
					break;
				case "image": {
					const lines = renderGeneratedImage(event.image, {
						cwd: options.cwd,
						// Only draw into a real terminal; a pipe gets the path.
						...(process.stdout.isTTY
							? { columns: process.stdout.columns, rows: process.stdout.rows }
							: { sixel: false }),
					});
					process.stdout.write(`${lines.join("\n")}\n`);
					break;
				}
				case "status":
					if (options.verbose) process.stderr.write(`· ${event.label}\n`);
					break;
				case "tool_start":
					if (options.verbose) process.stderr.write(`· ${event.summary}\n`);
					break;
				case "tool_end":
					if (options.verbose && event.execution.output.isError) {
						process.stderr.write(`✗ ${event.execution.toolCall.name} failed\n`);
					}
					break;
				case "assistant_message":
					session.sync(state);
					// Separate consecutive assistant turns in the output stream.
					if (messageText(event.message).trim().length > 0) process.stdout.write("\n");
					break;
				case "compacted":
					// Record the rewrite before more messages arrive; see interactive mode.
					session.recordCompaction(state, event.removed);
					if (options.verbose) process.stderr.write(`· compacted ${event.removed} earlier messages\n`);
					break;
				case "loop_detected":
					process.stderr.write("Stopped: the model was repeating itself.\n");
					failed = true;
					break;
				case "error":
					process.stderr.write(`${event.message}\n`);
					failed = true;
					break;
				case "turn_end":
					if (event.reason === "aborted") {
						process.stderr.write("Interrupted.\n");
						failed = true;
					}
					break;
			}
		}
	} finally {
		process.off("SIGINT", onSigint);
		session.sync(state);
	}
	return failed ? 1 : 0;
}
