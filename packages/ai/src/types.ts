/** JSON Schema fragment describing a tool's parameters. */
export interface JsonSchema {
	type?: string;
	description?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	enum?: unknown[];
	default?: unknown;
	[key: string]: unknown;
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	text: string;
	/** Opaque signature the model requires when thinking is replayed. */
	signature?: string;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	mimeType: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/**
	 * Opaque signature Gemini attaches to tool calls made while thinking. It
	 * must be replayed on the next turn or the model loses its reasoning
	 * context.
	 */
	thoughtSignature?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent | ImageContent;
export type UserContent = TextContent | ImageContent;

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	stopReason: StopReason;
	usage: Usage;
	/** Model that produced the message. */
	model?: string;
	/** Populated when `stopReason` is "error". */
	errorMessage?: string;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: UserContent[];
	isError: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type StopReason =
	/** Model finished its turn. */
	| "stop"
	/** Model requested one or more tools. */
	| "toolUse"
	/** Output token limit reached. */
	| "maxTokens"
	/** Blocked by safety filters. */
	| "safety"
	/** Cancelled by the caller. */
	| "aborted"
	/** Request failed; see `errorMessage`. */
	| "error";

export interface Usage {
	input: number;
	output: number;
	/** Tokens served from context cache, already included in `input`. */
	cacheRead: number;
	/** Thinking tokens, already included in `output`. */
	thinking: number;
	/** Estimated cost in USD, using the model's catalog pricing. */
	costUsd: number;
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 };
}

/** Accumulate usage across turns. */
export function addUsage(total: Usage, next: Usage): Usage {
	return {
		input: total.input + next.input,
		output: total.output + next.output,
		cacheRead: total.cacheRead + next.cacheRead,
		thinking: total.thinking + next.thinking,
		costUsd: total.costUsd + next.costUsd,
	};
}

export interface Tool {
	name: string;
	description: string;
	/** JSON Schema for the tool arguments. Must describe an object. */
	parameters: JsonSchema;
}

/** Everything sent to the model for one request. */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/** How much the model should think before answering. */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	maxOutputTokens?: number;
	thinking?: ThinkingLevel;
	signal?: AbortSignal;
}

/** Incremental events emitted while a response streams in. */
export type StreamEvent =
	| { type: "start"; model: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; toolCall: ToolCallContent }
	/** A generated image, emitted whole rather than streamed. */
	| { type: "image"; image: ImageContent }
	/** Terminal event; always emitted exactly once. */
	| { type: "done"; message: AssistantMessage };

/** Extract the plain text of an assistant message. */
export function messageText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Extract the tool calls of an assistant message. */
export function messageToolCalls(message: AssistantMessage): ToolCallContent[] {
	return message.content.filter((block): block is ToolCallContent => block.type === "toolCall");
}
