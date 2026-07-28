import {
	type Content,
	FinishReason,
	type FunctionDeclaration,
	ThinkingLevel as GenAiThinkingLevel,
	type GenerateContentConfig,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import type { VertexCredentials } from "../auth.ts";
import { formatVertexError } from "../errors.ts";
import { calculateCost, getCapabilities, inferApi, type ModelPricing } from "../models.ts";
import type {
	AssistantContent,
	AssistantMessage,
	Context,
	Message,
	StopReason,
	StreamEvent,
	StreamOptions,
	ThinkingLevel,
	Tool,
	ToolCallContent,
	Usage,
} from "../types.ts";

/** Thinking budgets in tokens for models that take a numeric budget. */
const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	off: 0,
	low: 4_096,
	medium: 16_384,
	// -1 lets the model decide how long to think.
	high: -1,
};

const THINKING_LEVELS: Record<ThinkingLevel, GenAiThinkingLevel> = {
	off: GenAiThinkingLevel.MINIMAL,
	low: GenAiThinkingLevel.LOW,
	medium: GenAiThinkingLevel.MEDIUM,
	high: GenAiThinkingLevel.HIGH,
};

/** Convert our tool definitions into Gemini function declarations. */
export function convertTools(tools: Tool[]): FunctionDeclaration[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// Passing JSON Schema straight through avoids lossy Schema conversion.
		parametersJsonSchema: tool.parameters,
	}));
}

function userParts(message: Extract<Message, { role: "user" }>): Part[] {
	if (typeof message.content === "string") return [{ text: message.content }];
	return message.content.map((block) =>
		block.type === "text" ? { text: block.text } : { inlineData: { mimeType: block.mimeType, data: block.data } },
	);
}

function assistantParts(content: AssistantContent[], replayThinking: boolean): Part[] {
	const parts: Part[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({ text: block.text });
		} else if (block.type === "thinking") {
			// Thought signatures are provider-specific; drop foreign ones rather
			// than replay a signature this model cannot verify.
			if (replayThinking) {
				parts.push({
					text: block.text,
					thought: true,
					...(block.signature ? { thoughtSignature: block.signature } : {}),
				});
			}
		} else {
			parts.push({
				functionCall: { id: block.id, name: block.name, args: block.arguments },
				...(replayThinking && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
			});
		}
	}
	return parts;
}

/**
 * Convert the conversation into Gemini `Content` turns.
 *
 * Tool results are sent as user-role function responses, and consecutive
 * results are merged into one turn so parallel tool calls answer together.
 */
export function convertMessages(messages: Message[]): Content[] {
	const contents: Content[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			contents.push({ role: "user", parts: userParts(message) });
			continue;
		}
		if (message.role === "assistant") {
			// Turns produced by a Claude model can appear here after /model.
			const sameProvider = message.model === undefined || inferApi(message.model) === "gemini";
			const parts = assistantParts(message.content, sameProvider);
			if (parts.length > 0) contents.push({ role: "model", parts });
			continue;
		}

		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const part: Part = {
			functionResponse: {
				id: message.toolCallId,
				name: message.toolName,
				// Gemini expects a JSON object; errors are reported in-band.
				response: message.isError ? { error: text } : { output: text },
			},
		};
		const previous = contents.at(-1);
		if (previous?.role === "user" && previous.parts?.[0]?.functionResponse) {
			previous.parts.push(part);
		} else {
			contents.push({ role: "user", parts: [part] });
		}

		// Images cannot ride inside a functionResponse, so they follow as user content.
		const images = message.content.filter((block) => block.type === "image");
		if (images.length > 0) {
			contents.push({
				role: "user",
				parts: images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
			});
		}
	}
	return contents;
}

function mapStopReason(reason: FinishReason | undefined, hasToolCalls: boolean): StopReason {
	if (hasToolCalls) return "toolUse";
	switch (reason) {
		case FinishReason.MAX_TOKENS:
			return "maxTokens";
		case FinishReason.SAFETY:
		case FinishReason.RECITATION:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.BLOCKLIST:
			return "safety";
		default:
			return "stop";
	}
}

function buildThinkingConfig(model: string, level: ThinkingLevel): ThinkingConfig {
	// Gemini 3 takes a categorical level; earlier models take a token budget.
	if (getCapabilities(model, "gemini").thinking === "gemini-level") {
		return { includeThoughts: level !== "off", thinkingLevel: THINKING_LEVELS[level] };
	}
	return { includeThoughts: level !== "off", thinkingBudget: THINKING_BUDGETS[level] };
}

/** Gemini-on-Vertex adapter. */
export class GeminiApi {
	readonly credentials: VertexCredentials;
	private readonly client: GoogleGenAI;
	private readonly pricing: (model: string) => ModelPricing | undefined;

	constructor(credentials: VertexCredentials, pricing: (model: string) => ModelPricing | undefined) {
		this.credentials = credentials;
		this.pricing = pricing;
		this.client = new GoogleGenAI({
			vertexai: true,
			project: credentials.project,
			location: credentials.location,
		});
	}

	/**
	 * Stream one assistant turn.
	 *
	 * Never throws: request failures and cancellation are reported as a final
	 * `done` event whose message carries `stopReason` "error" or "aborted".
	 */
	async *stream(model: string, context: Context, options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
		yield { type: "start", model };

		const info = getCapabilities(model, "gemini");
		const content: AssistantContent[] = [];
		const toolCalls: ToolCallContent[] = [];
		let text = "";
		let thinking = "";
		let thinkingSignature: string | undefined;
		let finishReason: FinishReason | undefined;
		let usage: Usage = { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 };

		const flushText = (): void => {
			if (thinking.length > 0) {
				content.push({
					type: "thinking",
					text: thinking,
					...(thinkingSignature ? { signature: thinkingSignature } : {}),
				});
				thinking = "";
				thinkingSignature = undefined;
			}
			if (text.length > 0) {
				content.push({ type: "text", text });
				text = "";
			}
		};

		try {
			const config: GenerateContentConfig = {
				...(context.systemPrompt ? { systemInstruction: context.systemPrompt } : {}),
				...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
				...(options.topP !== undefined ? { topP: options.topP } : {}),
				maxOutputTokens: options.maxOutputTokens ?? info.maxOutputTokens,
				...(context.tools?.length ? { tools: [{ functionDeclarations: convertTools(context.tools) }] } : {}),
				thinkingConfig: buildThinkingConfig(model, options.thinking ?? "medium"),
				...(options.signal ? { abortSignal: options.signal } : {}),
			};

			const stream = await this.client.models.generateContentStream({
				model,
				contents: convertMessages(context.messages),
				config,
			});

			for await (const chunk of stream) {
				if (options.signal?.aborted) break;
				usage = this.readUsage(chunk, info.id, usage);
				const candidate = chunk.candidates?.[0];
				if (candidate?.finishReason) finishReason = candidate.finishReason;

				for (const part of candidate?.content?.parts ?? []) {
					if (part.functionCall) {
						// Tool calls close out any pending text so ordering is preserved.
						flushText();
						const call: ToolCallContent = {
							type: "toolCall",
							id: part.functionCall.id ?? `call_${toolCalls.length}_${part.functionCall.name ?? "tool"}`,
							name: part.functionCall.name ?? "",
							arguments: part.functionCall.args ?? {},
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						};
						toolCalls.push(call);
						content.push(call);
						yield { type: "tool_call", toolCall: call };
						continue;
					}
					if (part.text === undefined || part.text.length === 0) continue;
					if (part.thought) {
						thinking += part.text;
						if (part.thoughtSignature) thinkingSignature = part.thoughtSignature;
						yield { type: "thinking_delta", delta: part.text };
					} else {
						text += part.text;
						yield { type: "text_delta", delta: part.text };
					}
				}
			}

			flushText();

			if (options.signal?.aborted) {
				yield { type: "done", message: this.finish(content, "aborted", usage, model) };
				return;
			}
			yield {
				type: "done",
				message: this.finish(content, mapStopReason(finishReason, toolCalls.length > 0), usage, model),
			};
		} catch (error) {
			flushText();
			if (options.signal?.aborted || isAbortError(error)) {
				yield { type: "done", message: this.finish(content, "aborted", usage, model) };
				return;
			}
			const message = this.finish(content, "error", usage, model);
			message.errorMessage = formatVertexError(error, this.credentials, model);
			yield { type: "done", message };
		}
	}

	private finish(content: AssistantContent[], stopReason: StopReason, usage: Usage, model: string): AssistantMessage {
		return { role: "assistant", content: [...content], stopReason, usage, model };
	}

	private readUsage(chunk: GenerateContentResponse, model: string, previous: Usage): Usage {
		const metadata = chunk.usageMetadata;
		if (!metadata) return previous;
		const usage: Usage = {
			input: metadata.promptTokenCount ?? previous.input,
			output: metadata.candidatesTokenCount ?? previous.output,
			cacheRead: metadata.cachedContentTokenCount ?? previous.cacheRead,
			thinking: metadata.thoughtsTokenCount ?? previous.thinking,
			costUsd: 0,
		};
		// Thinking tokens are billed as output but reported separately.
		usage.costUsd = calculateCost(this.pricing(model), { ...usage, output: usage.output + usage.thinking });
		return usage;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
