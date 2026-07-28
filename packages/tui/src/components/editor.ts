import type { Key } from "../keys.ts";
import { isPrintable, matchesKey } from "../keys.ts";
import { CURSOR_MARKER, type Focusable } from "../tui.ts";
import { visibleWidth } from "../utils.ts";

export interface EditorOptions {
	/** Prompt drawn on the first row, e.g. "> ". */
	prompt?: string;
	/** Prompt drawn on continuation rows. Defaults to spaces matching `prompt`. */
	continuationPrompt?: string;
	/** Text shown when the buffer is empty. */
	placeholder?: string;
	/** Called when the user submits with Enter. */
	onSubmit?: (text: string) => void;
	/** Called whenever the buffer changes. */
	onChange?: (text: string) => void;
	/** Style hook applied to each rendered row of buffer text. */
	style?: (text: string) => string;
	/** Style hook applied to the placeholder. */
	placeholderStyle?: (text: string) => string;
}

/** Position of a character offset within the soft-wrapped layout. */
interface WrapPosition {
	row: number;
	column: number;
}

interface WrapResult {
	rows: string[];
	cursor: WrapPosition;
}

/**
 * Soft-wrap a single logical line by display cells and locate `cursorOffset`
 * within the result. Wrapping by cell rather than by word keeps the caret
 * position unambiguous while typing.
 */
function wrapByCells(text: string, width: number, cursorOffset: number | undefined): WrapResult {
	const rows: string[] = [];
	let current = "";
	let currentWidth = 0;
	let cursor: WrapPosition = { row: 0, column: 0 };
	let offset = 0;

	const commit = () => {
		rows.push(current);
		current = "";
		currentWidth = 0;
	};

	for (const char of text) {
		if (cursorOffset === offset) cursor = { row: rows.length, column: currentWidth };
		const charWidth = visibleWidth(char);
		if (currentWidth + charWidth > width && currentWidth > 0) commit();
		current += char;
		currentWidth += charWidth;
		offset += char.length;
	}
	if (cursorOffset === offset) cursor = { row: rows.length, column: currentWidth };
	rows.push(current);
	return { rows, cursor };
}

/**
 * Multi-line text editor with history, emacs-style editing keys and
 * soft-wrapped rendering.
 */
export class Editor implements Focusable {
	focused = false;
	private text = "";
	/** Caret position as a UTF-16 offset into `text`. */
	private cursor = 0;
	private readonly options: EditorOptions;
	private readonly history: string[] = [];
	private historyIndex = -1;
	private historyDraft = "";
	/** Editing commands, keyed by the bindings that trigger them. */
	private readonly bindings: [string[], () => void][];

	constructor(options: EditorOptions = {}) {
		this.options = options;
		this.bindings = [
			[["ctrl+j"], () => this.insert("\n")],
			[["backspace"], () => this.deleteBackward()],
			[["delete"], () => this.deleteForward()],
			[["ctrl+left", "alt+b"], () => this.moveWord(-1)],
			[["ctrl+right", "alt+f"], () => this.moveWord(1)],
			[["left"], () => this.moveBy(-1)],
			[["right"], () => this.moveBy(1)],
			[["home", "ctrl+a"], () => this.moveToLineEdge(-1)],
			[["end", "ctrl+e"], () => this.moveToLineEdge(1)],
			[["up"], () => this.moveVertically(-1)],
			[["down"], () => this.moveVertically(1)],
			[["ctrl+k"], () => this.killToLineEnd()],
			[["ctrl+u"], () => this.killToLineStart()],
			[["ctrl+w"], () => this.deleteWordBackward()],
		];
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.cursor = text.length;
		this.options.onChange?.(this.text);
	}

	clear(): void {
		this.setText("");
	}

	/** Add an entry to the recallable input history. */
	pushHistory(entry: string): void {
		if (entry.trim().length === 0) return;
		if (this.history.at(-1) === entry) return;
		this.history.push(entry);
		this.historyIndex = -1;
	}

	render(width: number): string[] {
		const prompt = this.options.prompt ?? "> ";
		const continuation = this.options.continuationPrompt ?? " ".repeat(visibleWidth(prompt));
		const available = Math.max(1, width - visibleWidth(prompt));
		const style = this.options.style ?? ((text: string) => text);

		if (this.text.length === 0 && this.options.placeholder) {
			const placeholderStyle = this.options.placeholderStyle ?? ((text: string) => text);
			const marker = this.focused ? CURSOR_MARKER : "";
			return [prompt + marker + placeholderStyle(this.options.placeholder)];
		}

		const out: string[] = [];
		let consumed = 0;
		let cursorRow: number | undefined;
		let cursorColumn = 0;

		for (const line of this.text.split("\n")) {
			// Offset of the caret within this logical line, if it lands here.
			const relative =
				this.cursor >= consumed && this.cursor <= consumed + line.length ? this.cursor - consumed : undefined;
			const { rows, cursor } = wrapByCells(line, available, relative);
			if (relative !== undefined && cursorRow === undefined) {
				cursorRow = out.length + cursor.row;
				cursorColumn = cursor.column;
			}
			for (const row of rows) out.push(row);
			consumed += line.length + 1;
		}

		return out.map((row, index) => {
			const linePrompt = index === 0 ? prompt : continuation;
			if (!this.focused || index !== cursorRow) return linePrompt + style(row);
			// Split at the caret so the marker sits between styled runs.
			const before = sliceCells(row, 0, cursorColumn);
			const after = row.slice(before.length);
			return linePrompt + style(before) + CURSOR_MARKER + style(after);
		});
	}

	handlePaste(text: string): void {
		this.insert(text.replace(/\r\n?/g, "\n"));
	}

	handleInput(key: Key, raw: string): void {
		if (matchesKey(key, "enter")) {
			this.handleEnter(key);
			return;
		}

		const action = this.bindings.find(([keys]) => keys.some((candidate) => matchesKey(key, candidate)));
		if (action) {
			action[1]();
			return;
		}
		if (matchesKey(key, "space")) {
			this.insert(" ");
			return;
		}
		if (isPrintable(key)) this.insert(raw);
	}

	private handleEnter(key: Key): void {
		// Shift/alt+enter and a trailing backslash insert a newline instead of submitting.
		if (key.shift || key.alt) {
			this.insert("\n");
			return;
		}
		if (this.text.endsWith("\\")) {
			this.text = this.text.slice(0, -1);
			this.cursor = Math.max(0, this.cursor - 1);
			this.insert("\n");
			return;
		}
		const value = this.text;
		this.pushHistory(value);
		this.clear();
		this.options.onSubmit?.(value);
	}

	private insert(text: string): void {
		this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
		this.cursor += text.length;
		this.options.onChange?.(this.text);
	}

	private deleteBackward(): void {
		if (this.cursor === 0) return;
		// Step over a full code point so surrogate pairs delete as one character.
		const previous = [...this.text.slice(0, this.cursor)].at(-1) ?? "";
		this.text = this.text.slice(0, this.cursor - previous.length) + this.text.slice(this.cursor);
		this.cursor -= previous.length;
		this.options.onChange?.(this.text);
	}

	private deleteForward(): void {
		if (this.cursor >= this.text.length) return;
		const next = [...this.text.slice(this.cursor)][0] ?? "";
		this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + next.length);
		this.options.onChange?.(this.text);
	}

	private moveBy(direction: -1 | 1): void {
		if (direction < 0) {
			const previous = [...this.text.slice(0, this.cursor)].at(-1) ?? "";
			this.cursor = Math.max(0, this.cursor - previous.length);
		} else {
			const next = [...this.text.slice(this.cursor)][0] ?? "";
			this.cursor = Math.min(this.text.length, this.cursor + next.length);
		}
	}

	private moveWord(direction: -1 | 1): void {
		if (direction < 0) {
			const before = this.text.slice(0, this.cursor);
			const match = /\S+\s*$/.exec(before);
			this.cursor = match ? match.index : 0;
		} else {
			const after = this.text.slice(this.cursor);
			const match = /^\s*\S+/.exec(after);
			this.cursor += match ? match[0].length : after.length;
		}
	}

	private lineBounds(offset: number): { start: number; end: number } {
		const start = this.text.lastIndexOf("\n", offset - 1) + 1;
		const nextNewline = this.text.indexOf("\n", offset);
		return { start, end: nextNewline === -1 ? this.text.length : nextNewline };
	}

	private moveToLineEdge(direction: -1 | 1): void {
		const { start, end } = this.lineBounds(this.cursor);
		this.cursor = direction < 0 ? start : end;
	}

	private killToLineEnd(): void {
		const { end } = this.lineBounds(this.cursor);
		this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
		this.options.onChange?.(this.text);
	}

	private killToLineStart(): void {
		const { start } = this.lineBounds(this.cursor);
		this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
		this.cursor = start;
		this.options.onChange?.(this.text);
	}

	private deleteWordBackward(): void {
		const before = this.text.slice(0, this.cursor);
		const match = /\S+\s*$/.exec(before);
		const start = match ? match.index : 0;
		this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
		this.cursor = start;
		this.options.onChange?.(this.text);
	}

	/**
	 * Up/down move between logical lines. On the first or last line they walk
	 * the input history instead, matching shell behaviour.
	 */
	private moveVertically(direction: -1 | 1): void {
		const { start, end } = this.lineBounds(this.cursor);
		const column = this.cursor - start;
		if ((direction < 0 && start === 0) || (direction > 0 && end === this.text.length)) {
			this.recallHistory(direction);
			return;
		}
		if (direction < 0) {
			const previous = this.lineBounds(start - 1);
			this.cursor = Math.min(previous.start + column, previous.end);
		} else {
			const next = this.lineBounds(end + 1);
			this.cursor = Math.min(next.start + column, next.end);
		}
	}

	private recallHistory(direction: -1 | 1): void {
		if (this.history.length === 0) return;
		if (direction < 0) {
			if (this.historyIndex === -1) {
				this.historyDraft = this.text;
				this.historyIndex = this.history.length - 1;
			} else if (this.historyIndex > 0) {
				this.historyIndex -= 1;
			} else {
				return;
			}
		} else {
			if (this.historyIndex === -1) return;
			if (this.historyIndex < this.history.length - 1) {
				this.historyIndex += 1;
			} else {
				this.historyIndex = -1;
				this.setText(this.historyDraft);
				return;
			}
		}
		this.setText(this.history[this.historyIndex] ?? "");
	}
}

/** Slice a plain string by display cells, returning the raw substring. */
function sliceCells(text: string, start: number, end: number): string {
	let column = 0;
	let out = "";
	for (const char of text) {
		if (column >= end) break;
		if (column >= start) out += char;
		column += visibleWidth(char);
	}
	return out;
}
