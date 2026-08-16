import {
	type AssistantMessage,
	addUsage,
	type Context,
	emptyUsage,
	type Message,
	type ModelClient,
	messageToolCalls,
	type ToolCallContent,
	type ToolResultMessage,
	type UserContent,
} from "@jtui/ai";
import { compact, shouldCompact } from "./compaction.ts";
import { LoopDetector } from "./loop-detector.ts";
import type {
	AgentConfig,
	AgentEvent,
	AgentState,
	AgentTool,
	ToolContext,
	ToolExecution,
	ToolOutput,
} from "./types.ts";

const DEFAULT_MAX_TURNS = 100;

/** Create an empty conversation. */
export function createState(): AgentState {
	return { messages: [], totalUsage: emptyUsage() };
}

function toolResultContent(output: ToolOutput): UserContent[] {
	if (typeof output.content === "string") return [{ type: "text", text: output.content }];
	return output.content;
}

/** Check required properties are present so obvious model mistakes fail fast. */
function validateArguments(tool: AgentTool<never>, args: Record<string, unknown>): string | undefined {
	const required = tool.parameters.required ?? [];
	const missing = required.filter((name) => args[name] === undefined);
	if (missing.length > 0) return `Missing required argument(s): ${missing.join(", ")}`;
	return undefined;
}

async function executeTool(
	tools: AgentTool<never>[],
	toolCall: ToolCallContent,
	context: ToolContext,
): Promise<ToolExecution> {
	const startedAt = Date.now();
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	const finish = (output: ToolOutput): ToolExecution => ({
		toolCall,
		output,
		durationMs: Date.now() - startedAt,
	});

	if (!tool) {
		return finish({
			content: `Unknown tool "${toolCall.name}". Available tools: ${tools.map((entry) => entry.name).join(", ")}`,
			isError: true,
		});
	}
	const invalid = validateArguments(tool, toolCall.arguments);
	if (invalid) return finish({ content: invalid, isError: true });

	try {
		const output = await tool.execute(toolCall.arguments as never, context);
		return finish(output);
	} catch (error) {
		if (context.signal.aborted) return finish({ content: "Tool call was interrupted.", isError: true });
		const message = error instanceof Error ? error.message : String(error);
		return finish({ content: message, isError: true });
	}
}

function toolResultMessage(execution: ToolExecution): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: execution.toolCall.id,
		toolName: execution.toolCall.name,
		content: toolResultContent(execution.output),
		isError: execution.output.isError === true,
	};
}

/**
 * Run the agent until the model stops asking for tools.
 *
 * Yields events as they happen and mutates `state.messages` in place so the
 * caller keeps the full conversation even if the run is interrupted.
 */
export async function* runAgent(
	client: ModelClient,
	config: AgentConfig,
	state: AgentState,
	prompt: string | Message,
	signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	state.messages.push(typeof prompt === "string" ? { role: "user", content: prompt } : prompt);

	for (let turn = 1; turn <= maxTurns; turn++) {
		if (signal.aborted) {
			yield { type: "turn_end", reason: "aborted", usage: emptyUsage() };
			return;
		}
		yield { type: "turn_start", turn };

		// Summarize before building the request, so an over-long history is
		// shrunk rather than rejected by the API.
		if (config.compaction !== false && shouldCompact(state, config.model, config.compaction)) {
			yield { type: "compaction_start" };
			try {
				const result = await compact(client, config.model, state, config.compaction, signal);
				if (result) yield { type: "compacted", removed: result.removed, summary: result.summary };
			} catch (error) {
				// A failed summary must not kill the turn; the request may still fit.
				yield { type: "error", message: `Compaction failed: ${(error as Error).message}` };
			}
		}

		const context: Context = {
			systemPrompt: config.systemPrompt,
			messages: state.messages,
			tools: config.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		};

		let assistantMessage: AssistantMessage | undefined;
		// A turn-scoped controller so a detected loop can stop the stream
		// without cancelling the whole run.
		const turnController = new AbortController();
		const propagateAbort = () => turnController.abort();
		signal.addEventListener("abort", propagateAbort, { once: true });
		const detector = config.detectLoops === false ? undefined : new LoopDetector({ threshold: config.loopThreshold });
		let looped = false;

		try {
			for await (const event of client.stream(config.model, context, {
				temperature: config.temperature,
				thinking: config.thinking,
				maxOutputTokens: config.maxOutputTokens,
				signal: turnController.signal,
			})) {
				switch (event.type) {
					case "start":
						yield { type: "message_start", model: event.model };
						break;
					case "text_delta":
						yield { type: "text_delta", delta: event.delta };
						if (detector?.push(event.delta) && !looped) {
							looped = true;
							turnController.abort();
						}
						break;
					case "thinking_delta":
						yield { type: "thinking_delta", delta: event.delta };
						break;
					case "status":
						yield { type: "status", label: event.label };
						break;
					case "image":
						yield { type: "image", image: event.image };
						break;
					case "tool_call":
						// Surfaced again as tool_start once execution begins.
						break;
					case "done":
						assistantMessage = event.message;
						break;
				}
			}
		} finally {
			signal.removeEventListener("abort", propagateAbort);
		}

		if (looped) {
			const repeatedUnit = detector?.repeatedUnit ?? "";
			if (assistantMessage) {
				// Keep the partial answer so the user can see where it went wrong.
				assistantMessage.stopReason = "stop";
				state.messages.push(assistantMessage);
				state.totalUsage = addUsage(state.totalUsage, assistantMessage.usage);
				yield { type: "assistant_message", message: assistantMessage };
			}
			yield { type: "loop_detected", repeatedUnit };
			yield { type: "turn_end", reason: "stop", usage: assistantMessage?.usage ?? emptyUsage() };
			return;
		}

		if (!assistantMessage) {
			yield { type: "error", message: "Model stream ended without a response." };
			yield { type: "turn_end", reason: "error", usage: emptyUsage() };
			return;
		}

		state.messages.push(assistantMessage);
		state.totalUsage = addUsage(state.totalUsage, assistantMessage.usage);
		yield { type: "assistant_message", message: assistantMessage };

		if (assistantMessage.stopReason === "error") {
			yield { type: "error", message: assistantMessage.errorMessage ?? "Request failed." };
			yield { type: "turn_end", reason: "error", usage: assistantMessage.usage };
			return;
		}
		if (assistantMessage.stopReason === "aborted") {
			yield { type: "turn_end", reason: "aborted", usage: assistantMessage.usage };
			return;
		}

		const toolCalls = messageToolCalls(assistantMessage);
		if (toolCalls.length === 0) {
			yield { type: "turn_end", reason: assistantMessage.stopReason, usage: assistantMessage.usage };
			return;
		}

		const toolContext: ToolContext = { cwd: process.cwd(), signal };
		const executions: ToolExecution[] = [];

		if (config.parallelTools === false) {
			for (const toolCall of toolCalls) {
				yield { type: "tool_start", toolCall, summary: summarize(config.tools, toolCall) };
				const execution = await executeTool(config.tools, toolCall, toolContext);
				executions.push(execution);
				yield { type: "tool_end", execution };
			}
		} else {
			for (const toolCall of toolCalls) {
				yield { type: "tool_start", toolCall, summary: summarize(config.tools, toolCall) };
			}
			const settled = await Promise.all(toolCalls.map((toolCall) => executeTool(config.tools, toolCall, toolContext)));
			for (const execution of settled) {
				executions.push(execution);
				yield { type: "tool_end", execution };
			}
		}

		// Results must be appended in the order the model requested them.
		for (const execution of executions) state.messages.push(toolResultMessage(execution));
	}

	yield { type: "error", message: `Stopped after ${maxTurns} turns without a final answer.` };
	yield { type: "turn_end", reason: "stop", usage: emptyUsage() };
}

function summarize(tools: AgentTool<never>[], toolCall: ToolCallContent): string {
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool?.summarize) return toolCall.name;
	try {
		return tool.summarize(toolCall.arguments as never);
	} catch {
		return toolCall.name;
	}
}
