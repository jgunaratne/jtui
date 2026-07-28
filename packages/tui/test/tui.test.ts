import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/components/editor.ts";
import { Loader } from "../src/components/loader.ts";
import { Text } from "../src/components/text.ts";
import { parseKey, splitKeySequences } from "../src/keys.ts";
import { MemoryTerminal } from "../src/terminal.ts";
import { type Component, TUI } from "../src/tui.ts";
import { stripAnsi } from "../src/utils.ts";

/** Component that renders whatever lines it is given. */
class Lines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
}

function press(terminal: MemoryTerminal, sequence: string): void {
	terminal.send(sequence);
}

describe("TUI rendering", () => {
	let terminal: MemoryTerminal;
	let tui: TUI;

	beforeEach(() => {
		terminal = new MemoryTerminal(40, 10);
		tui = new TUI(terminal);
	});

	it("writes all lines on the first frame", () => {
		tui.root.add(new Lines(["alpha", "beta"]));
		tui.start();
		const output = terminal.text();
		expect(output).toContain("alpha");
		expect(output).toContain("beta");
	});

	it("rewrites only the rows that changed", () => {
		const lines = new Lines(["alpha", "beta", "gamma"]);
		tui.root.add(lines);
		tui.start();
		terminal.clear();

		lines.lines = ["alpha", "BETA", "gamma"];
		tui.render();

		const output = terminal.text();
		expect(output).toContain("BETA");
		// Unchanged rows are skipped entirely.
		expect(output).not.toContain("alpha");
		expect(output).not.toContain("gamma");
	});

	it("clears rows left over when the region shrinks", () => {
		const lines = new Lines(["one", "two", "three"]);
		tui.root.add(lines);
		tui.start();
		terminal.clear();

		lines.lines = ["one"];
		tui.render();

		// \x1b[0J erases from the cursor to the end of the screen.
		expect(terminal.text()).toContain("\x1b[0J");
	});

	it("repaints from scratch after a resize", () => {
		const lines = new Lines(["alpha", "beta"]);
		tui.root.add(lines);
		tui.start();
		terminal.clear();

		terminal.resize(20, 10);

		const output = terminal.text();
		expect(output).toContain("alpha");
		expect(output).toContain("beta");
	});

	it("commits static lines above the dynamic region", () => {
		tui.root.add(new Lines(["prompt"]));
		tui.start();
		terminal.clear();

		tui.addStatic(["committed line"]);

		const output = terminal.text();
		expect(output).toContain("committed line");
		// The dynamic region is repainted below the committed content.
		expect(output).toContain("prompt");
	});

	it("returns to column 0 before committing static lines", () => {
		// A focused editor parks the hardware cursor after its prompt, so
		// addStatic must move back to the start of the region first.
		const editor = new Editor({ prompt: "❯ " });
		tui.root.add(editor);
		tui.start();
		tui.setFocus(editor);
		tui.render();
		terminal.clear();

		tui.addStatic(["committed"]);

		const output = terminal.text();
		// The carriage return must come before the committed text.
		expect(output.indexOf("\r")).toBeLessThan(output.indexOf("committed"));
		expect(output).toContain("\x1b[2Kcommitted");
	});

	it("truncates the dynamic region to the terminal height", () => {
		tui.root.add(new Lines(Array.from({ length: 30 }, (_, index) => `row-${index}`)));
		tui.start();
		const output = stripAnsi(terminal.text());
		// Only the last 10 rows fit in a 10-row terminal.
		expect(output).toContain("row-29");
		expect(output).not.toContain("row-0\r");
	});
});

describe("TUI input routing", () => {
	it("sends keys to the focused component", () => {
		const terminal = new MemoryTerminal(40, 10);
		const tui = new TUI(terminal);
		const editor = new Editor();
		tui.root.add(editor);
		tui.start();
		tui.setFocus(editor);

		press(terminal, "hi");
		expect(editor.getText()).toBe("hi");
	});

	it("lets global handlers consume keys first", () => {
		const terminal = new MemoryTerminal(40, 10);
		const tui = new TUI(terminal);
		const editor = new Editor();
		tui.root.add(editor);
		tui.start();
		tui.setFocus(editor);

		let seen = 0;
		tui.onKey((key) => {
			if (key.name === "x") {
				seen += 1;
				return true;
			}
		});

		press(terminal, "x");
		expect(seen).toBe(1);
		expect(editor.getText()).toBe("");
	});

	it("delivers bracketed paste as a single chunk", () => {
		const terminal = new MemoryTerminal(40, 10);
		const tui = new TUI(terminal);
		const editor = new Editor();
		tui.root.add(editor);
		tui.start();
		tui.setFocus(editor);

		terminal.send("\x1b[200~line one\nline two\x1b[201~");
		expect(editor.getText()).toBe("line one\nline two");
	});

	it("reassembles a paste split across reads", () => {
		const terminal = new MemoryTerminal(40, 10);
		const tui = new TUI(terminal);
		const editor = new Editor();
		tui.root.add(editor);
		tui.start();
		tui.setFocus(editor);

		terminal.send("\x1b[200~first ");
		terminal.send("second\x1b[201~");
		expect(editor.getText()).toBe("first second");
	});
});

describe("key parsing", () => {
	it("decodes control characters", () => {
		expect(parseKey("\x03")).toMatchObject({ name: "c", ctrl: true });
		expect(parseKey("\r")).toMatchObject({ name: "enter" });
		expect(parseKey("\x7f")).toMatchObject({ name: "backspace" });
	});

	it("decodes arrows and modified arrows", () => {
		expect(parseKey("\x1b[A")).toMatchObject({ name: "up" });
		expect(parseKey("\x1b[1;5C")).toMatchObject({ name: "right", ctrl: true });
		expect(parseKey("\x1b[Z")).toMatchObject({ name: "tab", shift: true });
	});

	it("decodes kitty protocol keys", () => {
		expect(parseKey("\x1b[13;2u")).toMatchObject({ name: "enter", shift: true });
	});

	it("decodes alt-prefixed keys", () => {
		expect(parseKey("\x1bb")).toMatchObject({ name: "b", alt: true });
	});

	it("splits coalesced input into separate keys", () => {
		expect(splitKeySequences("ab\x1b[Ac")).toEqual(["a", "b", "\x1b[A", "c"]);
	});

	it("keeps surrogate pairs together", () => {
		expect(splitKeySequences("😀")).toEqual(["😀"]);
	});
});

describe("Editor", () => {
	it("submits on enter and clears", () => {
		const submitted: string[] = [];
		const editor = new Editor({ onSubmit: (text) => submitted.push(text) });
		for (const char of "hello") editor.handleInput(parseKey(char), char);
		editor.handleInput(parseKey("\r"), "\r");
		expect(submitted).toEqual(["hello"]);
		expect(editor.getText()).toBe("");
	});

	it("inserts a newline on shift+enter", () => {
		const editor = new Editor();
		editor.handleInput(parseKey("a"), "a");
		editor.handleInput(parseKey("\x1b[13;2u"), "\x1b[13;2u");
		editor.handleInput(parseKey("b"), "b");
		expect(editor.getText()).toBe("a\nb");
	});

	it("treats a trailing backslash as a line continuation", () => {
		const submitted: string[] = [];
		const editor = new Editor({ onSubmit: (text) => submitted.push(text) });
		for (const char of "foo\\") editor.handleInput(parseKey(char), char);
		editor.handleInput(parseKey("\r"), "\r");
		expect(submitted).toEqual([]);
		expect(editor.getText()).toBe("foo\n");
	});

	it("deletes words backward", () => {
		const editor = new Editor();
		editor.setText("alpha beta");
		editor.handleInput(parseKey("\x17"), "\x17");
		expect(editor.getText()).toBe("alpha ");
	});

	it("recalls history with the up arrow", () => {
		const editor = new Editor();
		editor.pushHistory("previous command");
		editor.handleInput(parseKey("\x1b[A"), "\x1b[A");
		expect(editor.getText()).toBe("previous command");
	});

	it("places the cursor marker at the caret", () => {
		const editor = new Editor({ prompt: "> " });
		editor.focused = true;
		editor.setText("abc");
		editor.handleInput(parseKey("\x1b[D"), "\x1b[D");
		const rendered = editor.render(40).join("");
		expect(stripAnsi(rendered)).toBe("> abc");
		// The marker sits between "ab" and "c".
		expect(rendered.indexOf("\x1b_jtui\x07")).toBe(rendered.indexOf("ab") + 2);
	});

	it("soft-wraps long input and keeps the caret on the right row", () => {
		const editor = new Editor({ prompt: "> " });
		editor.focused = true;
		editor.setText("x".repeat(15));
		const rows = editor.render(10);
		expect(rows.length).toBeGreaterThan(1);
		expect(stripAnsi(rows.join("")).replace(/[> ]/g, "")).toBe("x".repeat(15));
	});
});

describe("Text", () => {
	it("wraps and indents", () => {
		const text = new Text("alpha beta gamma", { indent: 2 });
		const rows = text.render(10);
		for (const row of rows) expect(row.startsWith("  ")).toBe(true);
	});

	it("applies a first-line prefix and continuation prefix", () => {
		const text = new Text("alpha beta gamma delta", { prefix: "- " });
		const rows = text.render(12);
		expect(rows[0]?.startsWith("- ")).toBe(true);
		expect(rows[1]?.startsWith("  ")).toBe(true);
	});
});

describe("Loader", () => {
	it("relabels and keeps running via begin()", () => {
		const loader = new Loader({ intervalMs: 10_000 });
		loader.begin("Thinking");
		expect(loader.running).toBe(true);
		expect(stripAnsi(loader.render().join(""))).toContain("Thinking");

		// A tool starting must not stop the animation, only rename it.
		loader.begin("bash npm test");
		expect(loader.running).toBe(true);
		expect(stripAnsi(loader.render().join(""))).toContain("bash npm test");
		loader.stop();
		expect(loader.render()).toEqual([]);
	});
});
