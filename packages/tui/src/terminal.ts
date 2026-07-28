import type { ReadStream, WriteStream } from "node:tty";

/** Minimal terminal surface the TUI renders against. */
export interface Terminal {
	/** Enter raw mode and begin delivering input and resize events. */
	start(onInput: (data: string) => void, onResize: () => void): void;
	/** Restore the terminal to its original state. */
	stop(): void;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

/** Terminal backed by the real process stdin/stdout. */
export class ProcessTerminal implements Terminal {
	private readonly input: ReadStream;
	private readonly output: WriteStream;
	private started = false;
	private onInput?: (data: string) => void;
	private onResize?: () => void;
	private readonly handleData = (chunk: Buffer | string) => {
		this.onInput?.(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
	};
	private readonly handleResize = () => {
		this.onResize?.();
	};

	constructor(input: ReadStream = process.stdin as ReadStream, output: WriteStream = process.stdout as WriteStream) {
		this.input = input;
		this.output = output;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.started) return;
		this.started = true;
		this.onInput = onInput;
		this.onResize = onResize;

		if (this.input.isTTY) this.input.setRawMode(true);
		this.input.setEncoding("utf8");
		this.input.resume();
		this.input.on("data", this.handleData);
		this.output.on("resize", this.handleResize);
		this.write(ENABLE_BRACKETED_PASTE + HIDE_CURSOR);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.write(DISABLE_BRACKETED_PASTE + SHOW_CURSOR);
		this.input.off("data", this.handleData);
		this.output.off("resize", this.handleResize);
		if (this.input.isTTY) this.input.setRawMode(false);
		this.input.pause();
	}

	write(data: string): void {
		this.output.write(data);
	}

	get columns(): number {
		return this.output.columns ?? 80;
	}

	get rows(): number {
		return this.output.rows ?? 24;
	}
}

/** In-memory terminal for tests: records everything written. */
export class MemoryTerminal implements Terminal {
	columns: number;
	rows: number;
	readonly output: string[] = [];
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;

	constructor(columns = 80, rows = 24) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.output.push(data);
	}

	/** Feed synthetic input to the attached TUI. */
	send(data: string): void {
		this.inputHandler?.(data);
	}

	/** Resize the surface and notify the attached TUI. */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}

	/** Everything written so far, concatenated. */
	text(): string {
		return this.output.join("");
	}

	clear(): void {
		this.output.length = 0;
	}
}
