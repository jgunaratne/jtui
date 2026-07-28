import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Message, StreamEvent, VertexClient } from "@jtui/ai";
import { describe, expect, it } from "vitest";
import { createState } from "../src/agent-loop.ts";
import {
	compact,
	contextUsage,
	contextWindowFor,
	findCutPoint,
	lastContextTokens,
	serializeForSummary,
	shouldCompact,
} from "../src/compaction.ts";
import { loadSession, Session } from "../src/session.ts";

function usage(input: number, output = 0) {
	return { input, output, cacheRead: 0, thinking: 0, costUsd: 0 };
}

function assistant(text: string, input = 0, output = 0): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: usage(input, output) };
}

function toolTurn(name: string, id: string): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: {} }],
			stopReason: "toolUse",
			usage: usage(0),
		},
		{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false },
	];
}

/** Client stub that returns a fixed summary. */
function summarizer(summary: string, record?: { context?: Context }): VertexClient {
	return {
		credentials: { project: "p", location: "l", projectSource: "t", credentialSource: "t" },
		async *stream(model: string, context: Context): AsyncGenerator<StreamEvent> {
			if (record) record.context = context;
			yield { type: "start", model };
			yield { type: "text_delta", delta: summary };
			yield { type: "done", message: assistant(summary) };
		},
	} as unknown as VertexClient;
}

describe("findCutPoint", () => {
	it("cuts at a user turn so tool results keep their call", () => {
		const messages: Message[] = [
			{ role: "user", content: "one" },
			...toolTurn("read", "a"),
			assistant("done one"),
			{ role: "user", content: "two" },
			...toolTurn("edit", "b"),
			assistant("done two"),
			{ role: "user", content: "three" },
			assistant("done three"),
		];
		const cut = findCutPoint(messages, 2);
		expect(cut).toBeDefined();
		// The kept tail must start with a user turn, never a tool result.
		expect(messages[cut as number]?.role).toBe("user");
		expect(messages.slice(cut).some((message) => message.role === "toolResult")).toBe(true);
		// Every kept tool result still has its calling assistant message.
		const kept = messages.slice(cut);
		for (let index = 0; index < kept.length; index++) {
			if (kept[index]?.role === "toolResult") expect(kept[index - 1]?.role).toBe("assistant");
		}
	});

	it("returns undefined when there is nothing worth cutting", () => {
		const messages: Message[] = [{ role: "user", content: "one" }, assistant("a")];
		expect(findCutPoint(messages, 2)).toBeUndefined();
	});

	it("keeps the requested number of user turns", () => {
		const messages: Message[] = [
			{ role: "user", content: "one" },
			assistant("a"),
			{ role: "user", content: "two" },
			assistant("b"),
			{ role: "user", content: "three" },
			assistant("c"),
		];
		const cut = findCutPoint(messages, 1) as number;
		expect(messages.slice(cut).filter((message) => message.role === "user")).toHaveLength(1);
	});
});

describe("context measurement", () => {
	it("reads the most recent request size", () => {
		const state = createState();
		state.messages.push({ role: "user", content: "hi" }, assistant("a", 100, 20));
		expect(lastContextTokens(state)).toBe(120);
	});

	it("derives the window from the model id", () => {
		expect(contextWindowFor("claude-sonnet-4-5")).toBe(200_000);
		expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
		expect(contextWindowFor("not-a-model")).toBeUndefined();
	});

	it("reports usage as a fraction", () => {
		const state = createState();
		state.messages.push({ role: "user", content: "hi" }, assistant("a", 100_000, 0));
		expect(contextUsage(state, "claude-sonnet-4-5")).toBeCloseTo(0.5, 3);
	});
});

describe("shouldCompact", () => {
	function longState(input: number) {
		const state = createState();
		for (let turn = 0; turn < 4; turn++) {
			state.messages.push({ role: "user", content: `turn ${turn}` }, assistant("reply", input, 0));
		}
		return state;
	}

	it("stays off below the threshold", () => {
		expect(shouldCompact(longState(10_000), "claude-sonnet-4-5")).toBe(false);
	});

	it("triggers above the threshold", () => {
		expect(shouldCompact(longState(180_000), "claude-sonnet-4-5")).toBe(true);
	});

	it("does not trigger when there is nothing to cut", () => {
		const state = createState();
		state.messages.push({ role: "user", content: "hi" }, assistant("a", 190_000, 0));
		expect(shouldCompact(state, "claude-sonnet-4-5")).toBe(false);
	});

	it("respects a custom threshold", () => {
		expect(shouldCompact(longState(60_000), "claude-sonnet-4-5", { threshold: 0.2 })).toBe(true);
	});
});

describe("compact", () => {
	function conversation() {
		const state = createState();
		state.messages.push(
			{ role: "user", content: "add a feature" },
			...toolTurn("read", "a"),
			assistant("read it", 10, 5),
			{ role: "user", content: "now test it" },
			...toolTurn("bash", "b"),
			assistant("tested", 20, 5),
			{ role: "user", content: "and document it" },
			assistant("documented", 30, 5),
		);
		return state;
	}

	it("replaces the head with a summary and keeps the tail", async () => {
		const state = conversation();
		const before = state.messages.length;
		const result = await compact(summarizer("Added and tested the feature."), "claude-sonnet-4-5", state, {
			keepRecentTurns: 1,
		});

		expect(result?.removed).toBeGreaterThan(0);
		expect(state.messages.length).toBeLessThan(before);
		const first = state.messages[0];
		expect(first?.role).toBe("user");
		expect(String(first?.content)).toContain("Added and tested the feature.");
		// The most recent exchange survives verbatim.
		expect(state.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("leaves no orphaned tool results", async () => {
		const state = conversation();
		await compact(summarizer("summary"), "claude-sonnet-4-5", state, { keepRecentTurns: 1 });
		for (let index = 0; index < state.messages.length; index++) {
			if (state.messages[index]?.role === "toolResult") {
				expect(state.messages[index - 1]?.role).toBe("assistant");
			}
		}
	});

	it("summarizes without tools or thinking", async () => {
		const record: { context?: Context } = {};
		await compact(summarizer("summary", record), "claude-sonnet-4-5", conversation(), { keepRecentTurns: 1 });
		expect(record.context?.tools ?? []).toHaveLength(0);
		expect(record.context?.messages).toHaveLength(1);
	});

	it("does nothing when history is too short", async () => {
		const state = createState();
		state.messages.push({ role: "user", content: "hi" }, assistant("a"));
		expect(await compact(summarizer("summary"), "claude-sonnet-4-5", state, { keepRecentTurns: 2 })).toBeUndefined();
		expect(state.messages).toHaveLength(2);
	});

	it("propagates a failed summarization instead of corrupting history", async () => {
		const failing = {
			credentials: { project: "p", location: "l", projectSource: "t", credentialSource: "t" },
			async *stream(model: string): AsyncGenerator<StreamEvent> {
				yield { type: "start", model };
				const message = assistant("");
				message.stopReason = "error";
				message.errorMessage = "429 rate limited";
				yield { type: "done", message };
			},
		} as unknown as VertexClient;

		const state = conversation();
		const before = [...state.messages];
		await expect(compact(failing, "claude-sonnet-4-5", state, { keepRecentTurns: 1 })).rejects.toThrow("429");
		expect(state.messages).toEqual(before);
	});
});

describe("serializeForSummary", () => {
	it("includes prompts, tool calls and results", () => {
		const text = serializeForSummary([
			{ role: "user", content: "do the thing" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "working" },
					{ type: "toolCall", id: "a", name: "edit", arguments: { path: "src/x.ts" } },
				],
				stopReason: "toolUse",
				usage: usage(0),
			},
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				isError: false,
			},
		]);
		expect(text).toContain("USER: do the thing");
		expect(text).toContain("TOOL CALL edit");
		expect(text).toContain("src/x.ts");
		expect(text).toContain("TOOL RESULT edit");
	});

	it("truncates large tool output", () => {
		const text = serializeForSummary([
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(5000) }],
				isError: false,
			},
		]);
		expect(text.length).toBeLessThan(1200);
	});
});

describe("session logging across compaction", () => {
	/**
	 * Regression: sync() tracked a plain index, so once compaction shrank the
	 * message array every later message fell inside the already-written range
	 * and was silently dropped from the transcript.
	 */
	it("keeps logging messages after the history is compacted", async () => {
		const directory = mkdtempSync(join(tmpdir(), "jtui-compact-"));
		try {
			const session = new Session(directory, "s1", { cwd: "/tmp", model: "m", startedAt: "now" });
			const state = createState();

			state.messages.push({ role: "user", content: "first" }, assistant("a", 10, 5));
			session.sync(state);
			state.messages.push({ role: "user", content: "second" }, assistant("b", 10, 5));
			session.sync(state);

			const removed = (await compact(summarizer("summary"), "claude-sonnet-4-5", state, { keepRecentTurns: 1 }))
				?.removed as number;
			expect(removed).toBeGreaterThan(0);
			// The host records the rewrite as soon as history is compacted.
			session.recordCompaction(state, removed);

			state.messages.push({ role: "user", content: "after compaction" }, assistant("c", 10, 5));
			session.sync(state);

			const logged = loadSession(session.path).messages;
			expect(JSON.stringify(logged)).toContain("after compaction");
			// The original turns stay on disk: the log records what happened.
			expect(readFileSync(session.path, "utf8")).toContain("first");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	/**
	 * Regression: resuming replayed the raw log, so a compacted session came back
	 * with the full history it had just shed while the usage figure still showed
	 * the small post-compaction request — the next turn would blow the window.
	 */
	it("resumes a compacted session with the compacted history", async () => {
		const directory = mkdtempSync(join(tmpdir(), "jtui-compact-"));
		try {
			const session = new Session(directory, "s1", { cwd: "/tmp", model: "m", startedAt: "now" });
			const state = createState();
			state.messages.push(
				{ role: "user", content: "first" },
				...toolTurn("read", "a"),
				assistant("a", 10, 5),
				{ role: "user", content: "second" },
				assistant("b", 10, 5),
			);
			session.sync(state);

			const removed = (await compact(summarizer("the summary"), "claude-sonnet-4-5", state, { keepRecentTurns: 1 }))
				?.removed as number;
			session.recordCompaction(state, removed);
			state.messages.push({ role: "user", content: "third" }, assistant("c", 10, 5));
			session.sync(state);

			const resumed = loadSession(session.path);
			expect(resumed.messages).toEqual(state.messages);
			expect(String(resumed.messages[0]?.content)).toContain("the summary");
			// No orphaned tool result can survive the replay.
			for (let index = 0; index < resumed.messages.length; index++) {
				if (resumed.messages[index]?.role === "toolResult") {
					expect(resumed.messages[index - 1]?.role).toBe("assistant");
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
