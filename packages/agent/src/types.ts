import type {
	AssistantMessage,
	ImageContent,
	JsonSchema,
	Message,
	StopReason,
	ToolCallContent,
	Usage,
	UserContent,
} from "@jtui/ai";
import type { CompactionSettings } from "./compaction.ts";

/** Runtime context handed to a tool during execution. */
export interface ToolContext {
	/** Working directory the agent was started in. */
	cwd: string;
	/** Aborted when the user interrupts the turn. */
	signal: AbortSignal;
	/** Report incremental progress, e.g. streaming command output. */
	onProgress?: (text: string) => void;
}

/** What a tool returns. Plain strings are wrapped as text content. */
export interface ToolOutput {
	content: string | UserContent[];
	isError?: boolean;
	/** Structured data for the UI; never sent to the model. */
	details?: unknown;
}

export interface AgentTool<Args = Record<string, unknown>> {
	name: string;
	description: string;
	/** JSON Schema describing an object of arguments. */
	parameters: JsonSchema;
	/** One-line summary shown in the UI while the tool runs. */
	summarize?: (args: Args) => string;
	execute(args: Args, context: ToolContext): Promise<ToolOutput>;
}

export interface ToolExecution {
	toolCall: ToolCallContent;
	output: ToolOutput;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
}

/** Events emitted while the agent runs. */
export type AgentEvent =
	| { type: "turn_start"; turn: number }
	| { type: "message_start"; model: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "text_delta"; delta: string }
	/** An image the model generated, complete rather than streamed. */
	| { type: "image"; image: ImageContent }
	| { type: "assistant_message"; message: AssistantMessage }
	| { type: "tool_start"; toolCall: ToolCallContent; summary: string }
	| { type: "tool_end"; execution: ToolExecution }
	| { type: "turn_end"; reason: StopReason; usage: Usage }
	/** The turn was cut short because the model looped. */
	| { type: "loop_detected"; repeatedUnit: string }
	| { type: "compaction_start" }
	| { type: "compacted"; removed: number; summary: string }
	| { type: "error"; message: string };

export interface AgentConfig {
	model: string;
	systemPrompt: string;
	tools: AgentTool<never>[];
	/** Stop after this many assistant turns in one run. */
	maxTurns?: number;
	/** Run independent tool calls concurrently. Defaults to true. */
	parallelTools?: boolean;
	temperature?: number;
	thinking?: "off" | "low" | "medium" | "high";
	maxOutputTokens?: number;
	/**
	 * Cut a turn short when the model starts repeating itself. Defaults to
	 * true; set false to let a looping model run to its token limit.
	 */
	detectLoops?: boolean;
	/** Repeats of the same output before a turn is judged stuck. Defaults to 5. */
	loopThreshold?: number;
	/**
	 * Summarize older history when the context window fills up. Defaults to on;
	 * set false to let a long session fail at the limit instead.
	 */
	compaction?: CompactionSettings | false;
}

/** Conversation state, persisted between runs. */
export interface AgentState {
	messages: Message[];
	totalUsage: Usage;
}
