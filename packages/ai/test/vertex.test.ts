import { describe, expect, it } from "vitest";
import { convertMessages, convertTools } from "../src/api/gemini.ts";
import { VertexClient } from "../src/client.ts";
import { formatVertexError } from "../src/errors.ts";
import { calculateCost, getCapabilities, inferApi } from "../src/models.ts";
import type { Message, Tool } from "../src/types.ts";

const credentials = {
	project: "my-project",
	location: "us-central1",
	projectSource: "test",
	credentialSource: "test",
};

describe("convertMessages", () => {
	it("maps user and assistant roles to Gemini roles", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, thinking: 0, costUsd: 0 },
			},
		];
		expect(convertMessages(messages)).toEqual([
			{ role: "user", parts: [{ text: "hello" }] },
			{ role: "model", parts: [{ text: "hi" }] },
		]);
	});

	it("round-trips tool calls with their thought signatures", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" }, thoughtSignature: "sig" },
				],
				stopReason: "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 },
			},
		];
		const [content] = convertMessages(messages);
		expect(content?.parts?.[0]).toEqual({
			functionCall: { id: "call-1", name: "read", args: { path: "a.ts" } },
			thoughtSignature: "sig",
		});
	});

	it("drops thinking produced by a Claude turn", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "claude reasoning", signature: "claude-sig" },
					{ type: "text", text: "answer" },
				],
				stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 },
				model: "claude-sonnet-4-5",
			},
		];
		const [content] = convertMessages(messages);
		expect(content?.parts).toEqual([{ text: "answer" }]);
	});

	it("preserves thinking blocks with their signature", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "thinking", text: "reasoning", signature: "abc" }],
				stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 },
			},
		];
		const [content] = convertMessages(messages);
		expect(content?.parts?.[0]).toEqual({ text: "reasoning", thought: true, thoughtSignature: "abc" });
	});

	it("merges consecutive tool results into one turn", () => {
		const messages: Message[] = [
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "1" }], isError: false },
			{ role: "toolResult", toolCallId: "b", toolName: "grep", content: [{ type: "text", text: "2" }], isError: false },
		];
		const contents = convertMessages(messages);
		expect(contents).toHaveLength(1);
		expect(contents[0]?.parts).toHaveLength(2);
	});

	it("reports failed tool results in an error field", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "read",
				content: [{ type: "text", text: "boom" }],
				isError: true,
			},
		];
		const [content] = convertMessages(messages);
		expect(content?.parts?.[0]?.functionResponse?.response).toEqual({ error: "boom" });
	});

	it("sends images as inline data", () => {
		const messages: Message[] = [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }];
		const [content] = convertMessages(messages);
		expect(content?.parts?.[0]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
	});

	it("drops assistant messages that produced no content", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				usage: { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 },
			},
		];
		expect(convertMessages(messages)).toEqual([]);
	});
});

describe("convertTools", () => {
	it("passes JSON Schema straight through", () => {
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		];
		expect(convertTools(tools)).toEqual([
			{
				name: "read",
				description: "Read a file",
				parametersJsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		]);
	});
});

describe("cost estimation", () => {
	it("charges cached input at the cached rate", () => {
		const pricing = { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.31 };
		const cost = calculateCost(pricing, { input: 1_000_000, output: 0, cacheRead: 1_000_000, thinking: 0 });
		expect(cost).toBeCloseTo(0.31, 5);
	});

	it("returns zero when no rate is configured", () => {
		expect(calculateCost(undefined, { input: 1_000_000, output: 1_000_000, cacheRead: 0, thinking: 0 })).toBe(0);
	});
});

describe("model routing", () => {
	it("routes by id prefix when the catalog has no entry", () => {
		expect(inferApi("claude-opus-5")).toBe("anthropic");
		expect(inferApi("gemini-2.5-pro")).toBe("gemini");
		expect(inferApi("llama-4-maverick")).toBeUndefined();
	});
});

describe("capability inference", () => {
	it("uses adaptive thinking for Claude 4.6 and newer", () => {
		expect(getCapabilities("claude-opus-5", "anthropic").thinking).toBe("anthropic-adaptive");
		expect(getCapabilities("claude-opus-4-8", "anthropic").thinking).toBe("anthropic-adaptive");
		expect(getCapabilities("claude-sonnet-4-6", "anthropic").thinking).toBe("anthropic-adaptive");
		expect(getCapabilities("claude-fable-5", "anthropic").thinking).toBe("anthropic-adaptive");
	});

	it("uses token budgets for Claude 4.5 and older", () => {
		expect(getCapabilities("claude-sonnet-4-5", "anthropic").thinking).toBe("anthropic-budget");
		expect(getCapabilities("claude-haiku-4-5", "anthropic").thinking).toBe("anthropic-budget");
		expect(getCapabilities("claude-3-opus", "anthropic").thinking).toBe("anthropic-budget");
	});

	it("ignores dated snapshot suffixes", () => {
		expect(getCapabilities("claude-opus-4-5@20251101", "anthropic").thinking).toBe("anthropic-budget");
		expect(getCapabilities("claude-3-5-sonnet-20241022", "anthropic").thinking).toBe("anthropic-budget");
	});

	it("only sends effort to models that accept it", () => {
		expect(getCapabilities("claude-opus-5", "anthropic").supportsEffort).toBe(true);
		expect(getCapabilities("claude-sonnet-4-5", "anthropic").supportsEffort).toBe(true);
		expect(getCapabilities("claude-3-opus", "anthropic").supportsEffort).toBe(false);
	});

	it("picks the thinking style Gemini expects", () => {
		expect(getCapabilities("gemini-3-pro-preview", "gemini").thinking).toBe("gemini-level");
		expect(getCapabilities("gemini-3.5-flash", "gemini").thinking).toBe("gemini-level");
		expect(getCapabilities("gemini-2.5-pro", "gemini").thinking).toBe("gemini-budget");
	});
});

describe("formatVertexError", () => {
	it("explains permission failures", () => {
		const message = formatVertexError(new Error("403 PERMISSION_DENIED"), credentials);
		expect(message).toContain("my-project");
		expect(message).toContain("Vertex AI User");
	});

	it("explains a missing model as an access problem", () => {
		const message = formatVertexError(new Error("404 NOT_FOUND"), credentials, "claude-opus-5");
		expect(message).toContain("us-central1");
		expect(message).toContain("claude-opus-5");
		expect(message).toContain("Model Garden");
	});

	it("explains quota exhaustion", () => {
		expect(formatVertexError(new Error("429 RESOURCE_EXHAUSTED"), credentials)).toContain("quota");
	});

	it("passes unrecognised errors through", () => {
		expect(formatVertexError(new Error("socket hang up"), credentials)).toBe("socket hang up");
	});
});

describe("VertexClient rebuild", () => {
	// /location rebuilds the client because both adapters bind the region when
	// they are constructed; rates must survive that.
	it("carries pricing onto a client rebuilt for another region", () => {
		const pricing = { "claude-opus-4-5": { inputPerMillion: 5, outputPerMillion: 25 } };
		const first = new VertexClient(credentials, { pricing });
		const second = new VertexClient({ ...first.credentials, location: "us-east5" }, { pricing: first.pricing });

		expect(second.credentials.location).toBe("us-east5");
		expect(second.credentials.project).toBe(first.credentials.project);
		expect(second.pricing).toEqual(pricing);
	});

	it("routes by id after a rebuild", () => {
		const client = new VertexClient({ ...credentials, location: "global" });
		expect(client.resolveApi("claude-sonnet-4-5")).toBe("anthropic");
		expect(client.resolveApi("gemini-2.5-pro")).toBe("gemini");
	});
});
