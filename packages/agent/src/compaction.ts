import { getCapabilities, inferApi, type Message, messageText, type VertexClient } from "@jtui/ai";
import type { AgentState } from "./types.ts";

export interface CompactionSettings {
	/** Fraction of the context window that triggers compaction. Defaults to 0.75. */
	threshold?: number;
	/** User turns kept verbatim at the tail. Defaults to 2. */
	keepRecentTurns?: number;
}

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_KEEP_RECENT_TURNS = 2;
/** Tool output is the bulk of a long session; cap each one in the summary input. */
const MAX_SERIALIZED_RESULT = 600;

const SUMMARY_PROMPT = `You are compacting a coding session so it can continue in a smaller context.

Write a summary that lets the assistant carry on without the original transcript. Prioritise, in order:

1. What the user asked for, including constraints and preferences they stated.
2. What has already been done — files created or changed, and how.
3. What was learned about the codebase: structure, conventions, key file paths, commands that work.
4. What is still outstanding, and any approach already ruled out.

Be specific. Keep exact file paths, function names, commands and error text. Do not speculate, do not add commentary, and do not describe the summary itself. Output only the summary.`;

/** Where the transcript can be cut without orphaning a tool result. */
export function findCutPoint(messages: Message[], keepRecentTurns: number): number | undefined {
	const userTurns: number[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") userTurns.push(index);
	}
	// Cutting at a user turn keeps every assistant tool call with its results,
	// which the APIs reject if separated.
	const cut = userTurns[Math.max(0, keepRecentTurns - 1)];
	if (cut === undefined || cut <= 0) return undefined;
	return cut;
}

/** Render messages as plain text for the summarizer. */
export function serializeForSummary(messages: Message[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join(" ");
			lines.push(`USER: ${text}`);
			continue;
		}
		if (message.role === "assistant") {
			const text = messageText(message).trim();
			if (text) lines.push(`ASSISTANT: ${text}`);
			for (const block of message.content) {
				if (block.type === "toolCall") {
					lines.push(`TOOL CALL ${block.name}: ${JSON.stringify(block.arguments).slice(0, 300)}`);
				}
			}
			continue;
		}
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.slice(0, MAX_SERIALIZED_RESULT);
		lines.push(`TOOL RESULT ${message.toolName}${message.isError ? " (error)" : ""}: ${text}`);
	}
	return lines.join("\n");
}

/** Tokens the model saw on the most recent request. */
export function lastContextTokens(state: AgentState): number {
	for (let index = state.messages.length - 1; index >= 0; index--) {
		const message = state.messages[index];
		if (message?.role === "assistant") return message.usage.input + message.usage.output;
	}
	return 0;
}

/** Context window for a model, or undefined when it cannot be determined. */
export function contextWindowFor(model: string): number | undefined {
	const api = inferApi(model);
	return api ? getCapabilities(model, api).contextWindow : undefined;
}

/** Fraction of the context window in use, 0 when not yet known. */
export function contextUsage(state: AgentState, model: string): number {
	const window = contextWindowFor(model);
	if (!window) return 0;
	return lastContextTokens(state) / window;
}

export interface CompactionResult {
	/** Messages replaced by the summary. */
	removed: number;
	summary: string;
}

/**
 * Replace the head of the conversation with a summary.
 *
 * The summary is produced by the same model and inserted as a user message, so
 * the tail of the session continues against a much smaller prompt. Returns
 * undefined when there is not enough history to be worth compacting.
 */
export async function compact(
	client: VertexClient,
	model: string,
	state: AgentState,
	settings: CompactionSettings = {},
	signal?: AbortSignal,
): Promise<CompactionResult | undefined> {
	const cut = findCutPoint(state.messages, settings.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS);
	if (cut === undefined) return undefined;

	const head = state.messages.slice(0, cut);
	const transcript = serializeForSummary(head);
	if (transcript.trim().length === 0) return undefined;

	let summary = "";
	for await (const event of client.stream(
		model,
		{
			systemPrompt: SUMMARY_PROMPT,
			messages: [{ role: "user", content: transcript }],
		},
		// No tools and no thinking: this is a summarization, not a turn.
		{ thinking: "off", signal },
	)) {
		if (event.type === "text_delta") summary += event.delta;
		if (event.type === "done" && event.message.stopReason === "error") {
			throw new Error(event.message.errorMessage ?? "Summarization failed.");
		}
	}

	summary = summary.trim();
	if (summary.length === 0) return undefined;

	state.messages.splice(0, cut, {
		role: "user",
		content: `[Earlier in this session, summarized to save context]\n\n${summary}`,
	});
	return { removed: cut, summary };
}

/** True when the conversation is close enough to the limit to compact. */
export function shouldCompact(state: AgentState, model: string, settings: CompactionSettings = {}): boolean {
	const threshold = settings.threshold ?? DEFAULT_THRESHOLD;
	const usage = contextUsage(state, model);
	if (usage < threshold) return false;
	return findCutPoint(state.messages, settings.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS) !== undefined;
}
