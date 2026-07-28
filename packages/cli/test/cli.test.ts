import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "@jtui/tui";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";
import { pickDefaultModel } from "../src/config.ts";
import { StreamingView } from "../src/modes/streaming-view.ts";
import { buildSystemPrompt, loadProjectContext } from "../src/system-prompt.ts";

const workspaces: string[] = [];
function workspace(): string {
	const path = mkdtempSync(join(tmpdir(), "jtui-cli-"));
	workspaces.push(path);
	return path;
}

afterEach(() => {
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("parseArgs", () => {
	it("defaults to an interactive run", () => {
		const args = parseArgs([]);
		expect(args).toMatchObject({ command: "run", print: false, errors: [] });
	});

	it("collects a multi-word prompt", () => {
		expect(parseArgs(["fix", "the", "build"]).prompt).toBe("fix the build");
	});

	it("parses flags with values", () => {
		const args = parseArgs(["-m", "gemini-3-pro-preview", "--location", "global", "--thinking", "high"]);
		expect(args).toMatchObject({ model: "gemini-3-pro-preview", location: "global", thinking: "high" });
	});

	it("recognises subcommands", () => {
		expect(parseArgs(["models"]).command).toBe("models");
		expect(parseArgs(["auth"]).command).toBe("auth");
		expect(parseArgs(["sessions"]).command).toBe("sessions");
	});

	it("implies print mode from --json", () => {
		const args = parseArgs(["--json", "hello"]);
		expect(args.print).toBe(true);
		expect(args.json).toBe(true);
	});

	it("requires a prompt in print mode", () => {
		expect(parseArgs(["-p"]).errors).toContain("--print requires a prompt");
	});

	it("rejects an invalid thinking level", () => {
		expect(parseArgs(["--thinking", "extreme"]).errors[0]).toContain("--thinking must be one of");
	});

	it("rejects a non-numeric turn limit", () => {
		expect(parseArgs(["--max-turns", "zero"]).errors[0]).toContain("--max-turns");
	});

	it("reports a flag missing its value", () => {
		expect(parseArgs(["--model"]).errors).toContain("--model requires a value");
	});

	it("reports unknown options", () => {
		expect(parseArgs(["--nope"]).errors).toContain("unknown option: --nope");
	});

	it("handles help and version", () => {
		expect(parseArgs(["--help"]).command).toBe("help");
		expect(parseArgs(["--version"]).command).toBe("version");
	});
});

describe("system prompt", () => {
	it("includes the working directory", () => {
		const cwd = workspace();
		expect(buildSystemPrompt({ cwd })).toContain(cwd);
	});

	it("loads project instructions from JTUI.md", () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "JTUI.md"), "Always use tabs.", "utf8");
		expect(loadProjectContext(cwd)).toMatchObject({ file: "JTUI.md" });
		expect(buildSystemPrompt({ cwd })).toContain("Always use tabs.");
	});

	it("prefers JTUI.md over AGENTS.md", () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "AGENTS.md"), "from agents", "utf8");
		writeFileSync(join(cwd, "JTUI.md"), "from jtui", "utf8");
		expect(buildSystemPrompt({ cwd })).toContain("from jtui");
		expect(buildSystemPrompt({ cwd })).not.toContain("from agents");
	});

	it("falls back to AGENTS.md then CLAUDE.md", () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "CLAUDE.md"), "from claude", "utf8");
		expect(loadProjectContext(cwd)?.file).toBe("CLAUDE.md");
	});

	it("can skip project context", () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "JTUI.md"), "secret instructions", "utf8");
		expect(buildSystemPrompt({ cwd, noProjectContext: true })).not.toContain("secret instructions");
	});

	it("ignores an empty instruction file", () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "JTUI.md"), "   \n", "utf8");
		expect(loadProjectContext(cwd)).toBeUndefined();
	});
});

describe("StreamingView", () => {
	it("commits finished lines and keeps the growing tail", () => {
		const committed: string[] = [];
		const view = new StreamingView((lines) => committed.push(...lines));

		view.append("first line\nsecond line\nthird");
		const tail = view.render(80);

		// Everything above the last line can no longer change.
		expect(committed.map(stripAnsi)).toEqual(["first line", "second line"]);
		expect(tail.map(stripAnsi)).toEqual(["third"]);
	});

	it("never commits the same line twice", () => {
		const committed: string[] = [];
		const view = new StreamingView((lines) => committed.push(...lines));

		view.append("one\ntwo\n");
		view.render(80);
		view.append("three\n");
		view.render(80);
		view.finish(80);

		expect(committed.map(stripAnsi).filter((line) => line === "one")).toHaveLength(1);
		expect(committed.map(stripAnsi)).toEqual(["one", "two", "three", ""]);
	});

	it("flushes the tail on finish and resets", () => {
		const committed: string[] = [];
		const view = new StreamingView((lines) => committed.push(...lines));

		view.append("only line");
		view.render(80);
		expect(committed).toHaveLength(0);

		view.finish(80);
		expect(committed.map(stripAnsi)).toEqual(["only line"]);
		expect(view.isEmpty).toBe(true);
	});

	it("does nothing when finishing an empty view", () => {
		const committed: string[] = [];
		const view = new StreamingView((lines) => committed.push(...lines));
		view.finish(80);
		expect(committed).toHaveLength(0);
	});

	it("renders markdown as it streams", () => {
		const committed: string[] = [];
		const view = new StreamingView((lines) => committed.push(...lines));
		view.append("# Heading\nbody text");
		view.render(80);
		expect(stripAnsi(committed[0] ?? "")).toBe("Heading");
	});
});

describe("pickDefaultModel", () => {
	it("prefers a Gemini pro model", () => {
		expect(pickDefaultModel(["gemini-2.5-flash", "gemini-2.5-pro", "claude-sonnet-4-5"])).toBe("gemini-2.5-pro");
	});

	it("picks the newest within a tier", () => {
		expect(pickDefaultModel(["gemini-2.5-pro", "gemini-3.5-pro"])).toBe("gemini-3.5-pro");
	});

	it("falls back to Claude when no Gemini model is available", () => {
		expect(pickDefaultModel(["claude-sonnet-4-5", "claude-haiku-4-5"])).toBe("claude-sonnet-4-5");
	});

	it("returns undefined when nothing is available", () => {
		expect(pickDefaultModel([])).toBeUndefined();
	});

	it("still returns something for unrecognised ids", () => {
		expect(pickDefaultModel(["some-new-model"])).toBe("some-new-model");
	});
});
