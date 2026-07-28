import type { AgentConfig, AgentState, Session } from "@jtui/agent";
import { runAgent } from "@jtui/agent";
import { messageText, type VertexClient } from "@jtui/ai";

export interface PrintOptions {
	client: VertexClient;
	config: AgentConfig;
	state: AgentState;
	session: Session;
	prompt: string;
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
				process.stdout.write(`${JSON.stringify(event)}\n`);
				if (event.type === "error") failed = true;
				continue;
			}
			switch (event.type) {
				case "text_delta":
					process.stdout.write(event.delta);
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
