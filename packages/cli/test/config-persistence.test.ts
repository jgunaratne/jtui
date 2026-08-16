import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => home };
});

const { globalConfigDir, loadConfig, saveGlobalConfig } = await import("../src/config.ts");

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jtui-config-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("saveGlobalConfig", () => {
	it("writes the chosen model so the next run reuses it", () => {
		saveGlobalConfig({ model: "gemini-3.7-flash" });
		expect(loadConfig(home).model).toBe("gemini-3.7-flash");
	});

	it("creates the config directory when it does not exist yet", () => {
		const path = saveGlobalConfig({ model: "claude-opus-4-8" });
		expect(path).toBe(join(globalConfigDir(), "config.json"));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "claude-opus-4-8" });
	});

	it("keeps unrelated settings when saving a model", () => {
		saveGlobalConfig({ location: "global", thinking: "high" });
		saveGlobalConfig({ model: "gemini-3.7-flash" });
		expect(loadConfig(home)).toMatchObject({ location: "global", thinking: "high", model: "gemini-3.7-flash" });
	});

	it("replaces a previously saved model rather than appending", () => {
		saveGlobalConfig({ model: "gemini-3.5-flash" });
		saveGlobalConfig({ model: "gemini-3.7-flash" });
		expect(loadConfig(home).model).toBe("gemini-3.7-flash");
	});

	it("does not lose the saved model when a malformed file is later written", () => {
		saveGlobalConfig({ model: "gemini-3.7-flash" });
		writeFileSync(join(globalConfigDir(), "config.json"), "{ not json", "utf8");
		// A malformed file is ignored rather than throwing, so the CLI still starts.
		expect(loadConfig(home).model).toBeUndefined();
	});

	it("is overridden by a project config, which takes precedence", () => {
		saveGlobalConfig({ model: "gemini-3.7-flash" });
		const project = mkdtempSync(join(tmpdir(), "jtui-project-"));
		mkdirSync(join(project, ".jtui"), { recursive: true });
		writeFileSync(join(project, ".jtui", "config.json"), JSON.stringify({ model: "claude-opus-4-8" }), "utf8");
		expect(loadConfig(project).model).toBe("claude-opus-4-8");
		rmSync(project, { recursive: true, force: true });
	});
});
