import { isPrintable, type Key, parseKey, splitKeySequences } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import { visibleWidth } from "./utils.ts";

/**
 * Zero-width APC marker a focused component emits at its caret position.
 * The TUI strips it and places the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_jtui\x07";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ERASE_LINE = "\x1b[2K";
const ERASE_BELOW = "\x1b[0J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** A renderable unit. Components own their own state and produce lines on demand. */
export interface Component {
	/** Render to lines at the given viewport width. Lines must not contain newlines. */
	render(width: number): string[];
	/** Handle a key press while focused. */
	handleInput?(key: Key, raw: string): void;
	/** Handle bracketed paste content while focused. */
	handlePaste?(text: string): void;
	/** Drop cached layout, e.g. after a resize. */
	invalidate?(): void;
}

/** Components that can hold focus and show the hardware cursor. */
export interface Focusable extends Component {
	focused: boolean;
}

export function isFocusable(component: Component | undefined): component is Focusable {
	return component !== undefined && "focused" in component;
}

/** Vertical stack of child components. */
export class Container implements Component {
	children: Component[] = [];

	add(...children: Component[]): void {
		this.children.push(...children);
	}

	remove(child: Component): void {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
	}

	clear(): void {
		this.children.length = 0;
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}
}

interface CursorPosition {
	row: number;
	column: number;
}

/** Result of a global key handler: true consumes the key. */
export type KeyHandler = (key: Key, raw: string) => boolean | undefined;

/**
 * Inline terminal UI with differential rendering.
 *
 * The screen is split into a static region that scrolls into terminal
 * scrollback and is never redrawn, and a dynamic region at the bottom that is
 * re-rendered on demand. Only rows whose content changed are rewritten.
 */
export class TUI {
	readonly root = new Container();
	private readonly terminal: Terminal;
	private readonly keyHandlers: KeyHandler[] = [];
	private renderedLines: string[] = [];
	/** Cursor row offset inside the dynamic region, relative to its first row. */
	private cursorRow = 0;
	private focused: Component | undefined;
	private renderScheduled = false;
	private running = false;
	/** True while a frame is being composed; guards against re-entrant renders. */
	private rendering = false;
	/** Static lines committed from inside render(), flushed once it finishes. */
	private pendingStatic: string[] = [];
	private pasteBuffer: string | undefined;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.handleResize(),
		);
		this.render();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		// Leave the dynamic region erased so the shell prompt starts clean.
		this.terminal.write(this.moveToRegionStart() + ERASE_BELOW + SHOW_CURSOR);
		this.renderedLines = [];
		this.terminal.stop();
	}

	/** Give keyboard focus to a component. */
	setFocus(component: Component | undefined): void {
		if (isFocusable(this.focused)) this.focused.focused = false;
		this.focused = component;
		if (isFocusable(component)) component.focused = true;
		this.requestRender();
	}

	getFocus(): Component | undefined {
		return this.focused;
	}

	/**
	 * Register a key handler that runs before the focused component.
	 * Returning true consumes the key.
	 */
	onKey(handler: KeyHandler): () => void {
		this.keyHandlers.push(handler);
		return () => {
			const index = this.keyHandlers.indexOf(handler);
			if (index >= 0) this.keyHandlers.splice(index, 1);
		};
	}

	/** Coalesce multiple render requests into one frame. */
	requestRender(): void {
		if (this.renderScheduled || !this.running) return;
		this.renderScheduled = true;
		setImmediate(() => {
			this.renderScheduled = false;
			this.render();
		});
	}

	/**
	 * Commit lines above the dynamic region. They scroll into terminal
	 * scrollback and are never touched again, which is how finished chat
	 * messages and tool output stay selectable and cheap.
	 */
	addStatic(lines: string[]): void {
		if (lines.length === 0) return;
		if (this.rendering) {
			// A component committed lines from inside its own render (the
			// streaming view does this as output finalizes). Writing now would
			// corrupt the half-composed frame and recurse, so queue it.
			this.pendingStatic.push(...lines);
			return;
		}
		this.writeStatic(lines);
	}

	private writeStatic(lines: string[]): void {
		let buffer = this.moveToRegionStart() + ERASE_BELOW;
		for (const line of lines) buffer += `${ERASE_LINE + line}\r\n`;
		this.terminal.write(buffer);
		// The dynamic region moved; force a full repaint of it.
		this.renderedLines = [];
		this.cursorRow = 0;
		this.render();
	}

	/** Render the dynamic region, rewriting only the rows that changed. */
	render(): void {
		if (!this.running || this.rendering) return;
		this.rendering = true;
		try {
			this.renderFrame();
		} finally {
			this.rendering = false;
		}
		// Flush anything a component committed while the frame was composing.
		// Each flush advances the committer's own state, so this terminates.
		while (this.pendingStatic.length > 0) {
			const pending = this.pendingStatic;
			this.pendingStatic = [];
			this.writeStatic(pending);
		}
	}

	private renderFrame(): void {
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);

		const rendered = this.root.render(width);
		const { lines, cursor } = this.extractCursor(rendered);
		// The dynamic region must fit on screen for relative cursor math to hold.
		const visible = lines.length > height ? lines.slice(lines.length - height) : lines;
		const cursorOffset = lines.length - visible.length;

		let buffer = this.moveToRegionStart();
		buffer += HIDE_CURSOR;

		for (let row = 0; row < visible.length; row++) {
			const line = visible[row] ?? "";
			if (this.renderedLines[row] !== line) {
				buffer += `${ERASE_LINE}${line}\r`;
			}
			// Advance with a newline so the terminal scrolls when the region grows.
			if (row < visible.length - 1) buffer += "\r\n";
		}

		this.cursorRow = Math.max(0, visible.length - 1);
		// Drop rows left over from a taller previous frame.
		if (this.renderedLines.length > visible.length) {
			buffer += `\r\n${ERASE_BELOW}`;
			this.cursorRow += 1;
		}
		this.renderedLines = visible;

		const target = cursor && cursor.row >= cursorOffset ? { ...cursor, row: cursor.row - cursorOffset } : undefined;
		buffer += this.moveCursorTo(target);
		if (target) buffer += SHOW_CURSOR;
		this.terminal.write(buffer);
	}

	/** Move the terminal cursor back to the first row of the dynamic region. */
	private moveToRegionStart(): string {
		const sequence = this.cursorRow > 0 ? `\x1b[${this.cursorRow}A\r` : "\r";
		this.cursorRow = 0;
		return sequence;
	}

	private moveCursorTo(target: CursorPosition | undefined): string {
		if (!target) return "";
		const rowDelta = target.row - this.cursorRow;
		let sequence = "\r";
		if (rowDelta > 0) sequence += `\x1b[${rowDelta}B`;
		if (rowDelta < 0) sequence += `\x1b[${-rowDelta}A`;
		if (target.column > 0) sequence += `\x1b[${target.column}C`;
		this.cursorRow = target.row;
		return sequence;
	}

	/** Strip the cursor marker from rendered lines and report where it was. */
	private extractCursor(lines: string[]): { lines: string[]; cursor: CursorPosition | undefined } {
		let cursor: CursorPosition | undefined;
		const out = lines.map((line, row) => {
			const index = line.indexOf(CURSOR_MARKER);
			if (index === -1) return line;
			cursor ??= { row, column: visibleWidth(line.slice(0, index)) };
			return line.replace(CURSOR_MARKER, "");
		});
		return { lines: out, cursor };
	}

	private handleResize(): void {
		this.root.invalidate();
		// Column changes invalidate every cached row; repaint from scratch.
		this.renderedLines = [];
		this.render();
	}

	private handleInput(data: string): void {
		let rest = data;
		while (rest.length > 0) {
			if (this.pasteBuffer !== undefined) {
				const end = rest.indexOf(PASTE_END);
				if (end === -1) {
					this.pasteBuffer += rest;
					return;
				}
				this.pasteBuffer += rest.slice(0, end);
				this.deliverPaste(this.pasteBuffer);
				this.pasteBuffer = undefined;
				rest = rest.slice(end + PASTE_END.length);
				continue;
			}
			const start = rest.indexOf(PASTE_START);
			if (start === -1) {
				this.deliverKeys(rest);
				return;
			}
			if (start > 0) this.deliverKeys(rest.slice(0, start));
			this.pasteBuffer = "";
			rest = rest.slice(start + PASTE_START.length);
		}
	}

	private deliverKeys(data: string): void {
		for (const sequence of splitKeySequences(data)) {
			const key = parseKey(sequence);
			let consumed = false;
			for (const handler of this.keyHandlers) {
				if (handler(key, sequence) === true) {
					consumed = true;
					break;
				}
			}
			if (!consumed) this.focused?.handleInput?.(key, sequence);
		}
		this.requestRender();
	}

	private deliverPaste(text: string): void {
		const focused = this.focused;
		if (!focused) return;
		if (focused.handlePaste) {
			focused.handlePaste(text);
		} else if (focused.handleInput) {
			for (const sequence of splitKeySequences(text)) {
				const key = parseKey(sequence);
				if (isPrintable(key) || key.name === "enter") focused.handleInput(key, sequence);
			}
		}
		this.requestRender();
	}
}
