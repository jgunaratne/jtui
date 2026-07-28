import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, StreamEvent, ToolCallContent, VertexClient } from "@jtui/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createState, runAgent } from "../src/agent-loop.ts";
import { listSessions, loadSession, Session } from "../src/session.ts";
import type { AgentConfig, AgentEvent, AgentTool } from "../src/types.ts";

const NO_USAGE = { input: 10, output: 5, cacheRead: 0, thinking: 0, costUsd: 0 };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", content, stopReason, usage: NO_USAGE, model: "test-model" };
}

function toolCall(name: string, args: Record<string, unknown>, id = "call-1"): ToolCallContent {
	return { type: "toolCall", id, name, arguments: args };
}

/**
 * Client stub that replays scripted turns and records the context it was
 * given, so the loop's message bookkeeping can be asserted.
 */
function fakeClient(turns: AssistantMessage[]): { client: VertexClient; contexts: Context[] } {
	const contexts: Context[] = [];
	let index = 0;
	const client = {
		credentials: { project: "p", location: "l", projectSource: "test", credentialSource: "test" },
		async *stream(model: string, context: Context): AsyncGenerator<StreamEvent> {
			// Snapshot the messages; the loop mutates the array in place.
			contexts.push({ ...context, messages: [...context.messages] });
			yield { type: "start", model };
			const message = turns[index++] ?? assistant([{ type: "text", text: "done" }], "stop");
			for (const block of message.content) {
				if (block.type === "text") yield { type: "text_delta", delta: block.text };
				if (block.type === "toolCall") yield { type: "tool_call", toolCall: block };
			}
			yield { type: "done", message };
		},
	} as unknown as VertexClient;
	return { client, contexts };
}

function config(tools: AgentTool<never>[] = [], overrides: Partial<AgentConfig> = {}): AgentConfig {
	return { model: "test-model", systemPrompt: "system", tools, ...overrides };
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of generator) events.push(event);
	return events;
}

const temporaryDirectories: string[] = [];
function temporaryDir(): string {
	const path = mkdtempSync(join(tmpdir(), "jtui-test-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("runAgent", () => {
	it("returns the answer when no tools are requested", async () => {
		const { client } = fakeClient([assistant([{ type: "text", text: "hello" }], "stop")]);
		const state = createState();
		const events = await collect(runAgent(client, config(), state, "hi", new AbortController().signal));

		expect(events.map((event) => event.type)).toContain("assistant_message");
		expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "stop" });
		expect(state.messages).toHaveLength(2);
	});

	it("executes a requested tool and feeds the result back", async () => {
		const calls: unknown[] = [];
		const echo: AgentTool<{ value: string }> = {
			name: "echo",
			description: "echo",
			parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
			async execute(args) {
				calls.push(args);
				return { content: `echoed ${args.value}` };
			},
		};
		const { client, contexts } = fakeClient([
			assistant([toolCall("echo", { value: "x" })], "toolUse"),
			assistant([{ type: "text", text: "finished" }], "stop"),
		]);
		const state = createState();
		const events = await collect(
			runAgent(client, config([echo as unknown as AgentTool<never>]), state, "go", new AbortController().signal),
		);

		expect(calls).toEqual([{ value: "x" }]);
		expect(events.filter((event) => event.type === "tool_end")).toHaveLength(1);
		// The second request must include the tool result.
		expect(contexts[1]?.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "echo", isError: false });
	});

	it("reports unknown tools back to the model instead of throwing", async () => {
		const { client } = fakeClient([
			assistant([toolCall("nope", {})], "toolUse"),
			assistant([{ type: "text", text: "ok" }], "stop"),
		]);
		const state = createState();
		const events = await collect(runAgent(client, config(), state, "go", new AbortController().signal));

		const end = events.find((event) => event.type === "tool_end");
		expect(end).toMatchObject({ execution: { output: { isError: true } } });
		expect(state.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("rejects tool calls that omit required arguments", async () => {
		const strict: AgentTool<{ path: string }> = {
			name: "read",
			description: "read",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			execute: async () => ({ content: "should not run" }),
		};
		const { client } = fakeClient([
			assistant([toolCall("read", {})], "toolUse"),
			assistant([{ type: "text", text: "ok" }], "stop"),
		]);
		const events = await collect(
			runAgent(
				client,
				config([strict as unknown as AgentTool<never>]),
				createState(),
				"go",
				new AbortController().signal,
			),
		);
		const end = events.find((event) => event.type === "tool_end");
		expect(end).toMatchObject({ execution: { output: { isError: true } } });
		expect(JSON.stringify(end)).toContain("Missing required argument");
	});

	it("converts a thrown tool error into an error result", async () => {
		const failing: AgentTool = {
			name: "boom",
			description: "boom",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				throw new Error("kaboom");
			},
		};
		const { client } = fakeClient([
			assistant([toolCall("boom", {})], "toolUse"),
			assistant([{ type: "text", text: "ok" }], "stop"),
		]);
		const events = await collect(
			runAgent(
				client,
				config([failing as unknown as AgentTool<never>]),
				createState(),
				"go",
				new AbortController().signal,
			),
		);
		expect(JSON.stringify(events.find((event) => event.type === "tool_end"))).toContain("kaboom");
	});

	it("runs parallel tool calls concurrently", async () => {
		let active = 0;
		let peak = 0;
		const slow: AgentTool = {
			name: "slow",
			description: "slow",
			parameters: { type: "object", properties: {} },
			async execute() {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
				active -= 1;
				return { content: "done" };
			},
		};
		const { client } = fakeClient([
			assistant([toolCall("slow", {}, "a"), toolCall("slow", {}, "b")], "toolUse"),
			assistant([{ type: "text", text: "ok" }], "stop"),
		]);
		await collect(
			runAgent(
				client,
				config([slow as unknown as AgentTool<never>]),
				createState(),
				"go",
				new AbortController().signal,
			),
		);
		expect(peak).toBe(2);
	});

	it("stops at the turn limit", async () => {
		const loopTool: AgentTool = {
			name: "loop",
			description: "loop",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "again" }),
		};
		// Always asks for another tool, so only maxTurns ends the run.
		const { client } = fakeClient(Array.from({ length: 10 }, () => assistant([toolCall("loop", {})], "toolUse")));
		const events = await collect(
			runAgent(
				client,
				config([loopTool as unknown as AgentTool<never>], { maxTurns: 3 }),
				createState(),
				"go",
				new AbortController().signal,
			),
		);
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(3);
		expect(JSON.stringify(events.at(-2))).toContain("Stopped after 3 turns");
	});

	it("surfaces a provider error and stops", async () => {
		const failed = assistant([], "error");
		failed.errorMessage = "403 PERMISSION_DENIED";
		const { client } = fakeClient([failed]);
		const events = await collect(runAgent(client, config(), createState(), "go", new AbortController().signal));

		expect(events.find((event) => event.type === "error")).toMatchObject({ message: "403 PERMISSION_DENIED" });
		expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
	});

	it("does not start when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, contexts } = fakeClient([assistant([{ type: "text", text: "hi" }], "stop")]);
		const events = await collect(runAgent(client, config(), createState(), "go", controller.signal));

		expect(contexts).toHaveLength(0);
		expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
	});

	it("accumulates usage across turns", async () => {
		const { client } = fakeClient([
			assistant([toolCall("missing", {})], "toolUse"),
			assistant([{ type: "text", text: "ok" }], "stop"),
		]);
		const state = createState();
		await collect(runAgent(client, config(), state, "go", new AbortController().signal));
		expect(state.totalUsage.input).toBe(20);
		expect(state.totalUsage.output).toBe(10);
	});
});

describe("sessions", () => {
	it("persists and reloads a transcript", async () => {
		const directory = temporaryDir();
		const session = new Session(directory, "s1", { cwd: "/tmp", model: "m", startedAt: "now" });
		const { client } = fakeClient([assistant([{ type: "text", text: "hello" }], "stop")]);
		const state = createState();
		await collect(runAgent(client, config(), state, "hi", new AbortController().signal));
		session.sync(state);

		const reloaded = loadSession(session.path);
		expect(reloaded.messages).toHaveLength(2);
		expect(reloaded.messages[0]).toMatchObject({ role: "user", content: "hi" });
		expect(reloaded.totalUsage.input).toBe(10);
	});

	it("only appends messages it has not written yet", () => {
		const directory = temporaryDir();
		const session = new Session(directory, "s2", { cwd: "/tmp", model: "m", startedAt: "now" });
		const state = createState();
		state.messages.push({ role: "user", content: "one" });
		session.sync(state);
		state.messages.push({ role: "user", content: "two" });
		session.sync(state);

		expect(loadSession(session.path).messages).toHaveLength(2);
	});

	it("lists sessions newest first with their opening prompt", () => {
		const directory = temporaryDir();
		const session = new Session(directory, "s3", { cwd: "/tmp", model: "m", startedAt: "now" });
		const state = createState();
		state.messages.push({ role: "user", content: "first prompt here" });
		session.sync(state);

		const summaries = listSessions(directory);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ id: "s3", firstPrompt: "first prompt here", messageCount: 1 });
	});

	it("tolerates a truncated final line", () => {
		const directory = temporaryDir();
		const session = new Session(directory, "s4", { cwd: "/tmp", model: "m", startedAt: "now" });
		const state = createState();
		state.messages.push({ role: "user", content: "ok" });
		session.sync(state);
		// Simulate a process killed mid-write.
		appendFileSync(session.path, '{"type":"message","mess');

		expect(loadSession(session.path).messages).toHaveLength(1);
	});
});
