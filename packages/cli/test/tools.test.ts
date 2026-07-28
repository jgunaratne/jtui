import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@jtui/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashExecutor, createBashTool } from "../src/tools/bash-tool.ts";
import { truncateOutput } from "../src/tools/common.ts";
import { editTool, listTool, readTool, writeTool } from "../src/tools/file-tools.ts";
import { globTool, grepTool } from "../src/tools/search-tools.ts";

let workspace: string;
let context: ToolContext;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "jtui-tools-"));
	context = { cwd: workspace, signal: new AbortController().signal };
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function write(relativePath: string, content: string): string {
	const path = join(workspace, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

describe("read", () => {
	it("returns numbered lines", async () => {
		write("a.txt", "one\ntwo\nthree");
		const result = await readTool.execute({ path: "a.txt" }, context);
		expect(result.content).toContain("1\tone");
		expect(result.content).toContain("3\tthree");
	});

	it("pages with offset and limit", async () => {
		write("a.txt", Array.from({ length: 100 }, (_, index) => `line${index + 1}`).join("\n"));
		const result = await readTool.execute({ path: "a.txt", offset: 50, limit: 2 }, context);
		expect(result.content).toContain("50\tline50");
		expect(result.content).toContain("51\tline51");
		expect(result.content).not.toContain("line52\n");
		expect(result.content).toContain("more lines");
	});

	it("errors on a missing file", async () => {
		const result = await readTool.execute({ path: "nope.txt" }, context);
		expect(result.isError).toBe(true);
	});

	it("refuses binary files", async () => {
		writeFileSync(join(workspace, "bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const result = await readTool.execute({ path: "bin" }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("binary");
	});

	it("points at the list tool for directories", async () => {
		mkdirSync(join(workspace, "sub"));
		const result = await readTool.execute({ path: "sub" }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("list tool");
	});
});

describe("write", () => {
	it("creates a file and its parent directories", async () => {
		const result = await writeTool.execute({ path: "deep/nested/file.txt", content: "hello" }, context);
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(workspace, "deep/nested/file.txt"), "utf8")).toBe("hello");
		expect(result.content).toContain("Created");
	});

	it("reports an overwrite as an update", async () => {
		write("a.txt", "old");
		const result = await writeTool.execute({ path: "a.txt", content: "new" }, context);
		expect(result.content).toContain("Updated");
	});
});

describe("edit", () => {
	it("replaces a unique match", async () => {
		write("a.ts", "const x = 1;\nconst y = 2;\n");
		const result = await editTool.execute(
			{ path: "a.ts", old_text: "const y = 2;", new_text: "const y = 3;" },
			context,
		);
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(workspace, "a.ts"), "utf8")).toContain("const y = 3;");
	});

	it("refuses an ambiguous match", async () => {
		write("a.ts", "foo\nfoo\n");
		const result = await editTool.execute({ path: "a.ts", old_text: "foo", new_text: "bar" }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("appears 2 times");
	});

	it("replaces every occurrence with replace_all", async () => {
		write("a.ts", "foo\nfoo\n");
		const result = await editTool.execute(
			{ path: "a.ts", old_text: "foo", new_text: "bar", replace_all: true },
			context,
		);
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(workspace, "a.ts"), "utf8")).toBe("bar\nbar\n");
	});

	it("errors when the text is not present", async () => {
		write("a.ts", "hello");
		const result = await editTool.execute({ path: "a.ts", old_text: "missing", new_text: "x" }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("read it again");
	});

	it("rejects a no-op edit", async () => {
		write("a.ts", "hello");
		const result = await editTool.execute({ path: "a.ts", old_text: "same", new_text: "same" }, context);
		expect(result.isError).toBe(true);
	});
});

describe("list", () => {
	it("lists directories before files", async () => {
		write("b.txt", "x");
		mkdirSync(join(workspace, "adir"));
		const result = await listTool.execute({}, context);
		const lines = String(result.content).split("\n");
		expect(lines[0]).toContain("adir/");
		expect(lines[1]).toContain("b.txt");
	});

	it("errors on a missing directory", async () => {
		const result = await listTool.execute({ path: "nope" }, context);
		expect(result.isError).toBe(true);
	});
});

describe("glob", () => {
	it("finds files by pattern", async () => {
		write("src/a.ts", "");
		write("src/b.js", "");
		const result = await globTool.execute({ pattern: "src/*.ts" }, context);
		expect(result.content).toContain("a.ts");
		expect(result.content).not.toContain("b.js");
	});

	it("reports when nothing matches", async () => {
		const result = await globTool.execute({ pattern: "*.nothing" }, context);
		expect(result.content).toContain("No files matching");
	});
});

describe("grep", () => {
	it("finds matching lines with file and line numbers", async () => {
		write("a.ts", "const needle = 1;\nconst other = 2;\n");
		const result = await grepTool.execute({ pattern: "needle" }, context);
		expect(result.content).toMatch(/a\.ts:1:/);
	});

	it("reports when nothing matches", async () => {
		write("a.ts", "nothing here");
		const result = await grepTool.execute({ pattern: "zzzzz" }, context);
		expect(result.content).toContain("No matches");
	});

	it("rejects an invalid regular expression", async () => {
		const result = await grepTool.execute({ pattern: "([" }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Invalid regular expression");
	});
});

describe("bash", () => {
	it("captures stdout", async () => {
		const tool = createBashTool(new BashExecutor(workspace));
		const result = await tool.execute({ command: "echo hello" }, context);
		expect(result.content).toBe("hello");
		expect(result.isError).toBe(false);
	});

	it("reports a non-zero exit code as an error", async () => {
		const tool = createBashTool(new BashExecutor(workspace));
		const result = await tool.execute({ command: "exit 3" }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Exit code: 3");
	});

	it("keeps the working directory between calls", async () => {
		mkdirSync(join(workspace, "sub"));
		const executor = new BashExecutor(workspace);
		const tool = createBashTool(executor);
		await tool.execute({ command: "cd sub" }, context);
		const result = await tool.execute({ command: "basename $PWD" }, context);
		expect(result.content).toBe("sub");
		expect(executor.cwd.endsWith("sub")).toBe(true);
	});

	it("does not leak the cwd marker into output", async () => {
		const tool = createBashTool(new BashExecutor(workspace));
		const result = await tool.execute({ command: "echo done" }, context);
		expect(result.content).not.toContain("JTUI_CWD");
	});

	it("times out a hanging command", async () => {
		const tool = createBashTool(new BashExecutor(workspace));
		const result = await tool.execute({ command: "sleep 5", timeout_ms: 200 }, context);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("timed out");
	});

	it("stops when the run is aborted", async () => {
		const controller = new AbortController();
		const tool = createBashTool(new BashExecutor(workspace));
		const promise = tool.execute({ command: "sleep 5" }, { ...context, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.content).toContain("interrupted");
	});
});

describe("truncateOutput", () => {
	it("leaves short output alone", () => {
		expect(truncateOutput("short", 100)).toBe("short");
	});

	it("keeps both ends of long output", () => {
		const text = `START${"x".repeat(1000)}END`;
		const truncated = truncateOutput(text, 100);
		expect(truncated.startsWith("START")).toBe(true);
		expect(truncated.endsWith("END")).toBe(true);
		expect(truncated).toContain("truncated");
	});
});
