import { describe, expect, it } from "vitest";
import { convertMessages, convertTools } from "../src/api/anthropic.ts";
import type { Message, Tool } from "../src/types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, thinking: 0, costUsd: 0 };

describe("anthropic convertMessages", () => {
	it("maps user and assistant turns", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", usage },
		];
		expect(convertMessages(messages)).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		]);
	});

	it("replays thinking blocks with their signature", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "reasoning", signature: "sig" },
					{ type: "text", text: "answer" },
				],
				stopReason: "stop",
				usage,
			},
		];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([
			{ type: "thinking", thinking: "reasoning", signature: "sig" },
			{ type: "text", text: "answer" },
		]);
	});

	it("drops thinking blocks with no signature, which the API rejects", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "unsigned" },
					{ type: "text", text: "answer" },
				],
				stopReason: "stop",
				usage,
			},
		];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("maps tool calls to tool_use blocks", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
				usage,
			},
		];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } }]);
	});

	it("merges parallel tool results into one user turn", () => {
		const messages: Message[] = [
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "1" }], isError: false },
			{ role: "toolResult", toolCallId: "b", toolName: "grep", content: [{ type: "text", text: "2" }], isError: false },
		];
		const turns = convertMessages(messages);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.content).toHaveLength(2);
	});

	it("flags failed tool results", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "bash",
				content: [{ type: "text", text: "boom" }],
				isError: true,
			},
		];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([
			{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "boom" }], is_error: true },
		]);
	});

	it("sends images as base64 blocks", () => {
		const messages: Message[] = [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("carries images in tool results", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "read",
				content: [
					{ type: "text", text: "Image logo.png:" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				isError: false,
			},
		];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "a",
				content: [
					{ type: "text", text: "Image logo.png:" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
				],
				is_error: false,
			},
		]);
	});

	it("skips assistant turns that produced nothing", () => {
		const messages: Message[] = [{ role: "assistant", content: [], stopReason: "error", usage }];
		expect(convertMessages(messages)).toEqual([]);
	});
});

describe("anthropic convertTools", () => {
	it("maps parameters to input_schema", () => {
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
				input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		]);
	});
});

describe("cross-provider history", () => {
	it("drops thinking produced by a Gemini turn", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "gemini reasoning", signature: "gemini-sig" },
					{ type: "text", text: "answer" },
				],
				stopReason: "stop",
				usage,
				model: "gemini-2.5-pro",
			},
		];
		const [turn] = convertMessages(messages);
		// A Gemini signature is meaningless to Claude and would be rejected.
		expect(turn?.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("keeps thinking produced by a Claude turn", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "thinking", text: "claude reasoning", signature: "sig" }],
				stopReason: "stop",
				usage,
				model: "claude-sonnet-4-5",
			},
		];
		const [turn] = convertMessages(messages);
		expect(turn?.content).toEqual([{ type: "thinking", thinking: "claude reasoning", signature: "sig" }]);
	});
});
