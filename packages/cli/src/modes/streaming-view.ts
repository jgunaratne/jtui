import { type Component, renderMarkdown } from "@jtui/tui";

/**
 * Renders an assistant message while it streams.
 *
 * Lines that can no longer change are handed to `commit`, which writes them
 * into terminal scrollback. Only the still-growing tail stays in the redrawn
 * region, so a long answer neither flickers nor gets written twice.
 */
export class StreamingView implements Component {
	private text = "";
	private committedLines = 0;
	private lastWidth = 0;
	private readonly commit: (lines: string[]) => void;
	private readonly style: (line: string) => string;

	constructor(commit: (lines: string[]) => void, style?: (line: string) => string) {
		this.commit = commit;
		this.style = style ?? ((line) => line);
	}

	get isEmpty(): boolean {
		return this.text.length === 0;
	}

	append(delta: string): void {
		this.text += delta;
	}

	private renderLines(width: number): string[] {
		return renderMarkdown(this.text, width).map(this.style);
	}

	render(width: number): string[] {
		if (this.text.length === 0) return [];
		// A width change invalidates previously committed line boundaries, so
		// stop committing and render the remainder in place.
		if (this.lastWidth !== 0 && this.lastWidth !== width) {
			return this.renderLines(width).slice(this.committedLines);
		}
		this.lastWidth = width;

		const lines = this.renderLines(width);
		// The final line may still grow, so it is never committed here.
		const finalized = lines.slice(this.committedLines, Math.max(this.committedLines, lines.length - 1));
		if (finalized.length > 0) {
			// Advance before committing: `commit` writes to the host, which may
			// render again, and that nested render must not see these lines as
			// still pending or it commits them a second time.
			this.committedLines += finalized.length;
			this.commit(finalized);
		}
		return lines.slice(this.committedLines);
	}

	/** Flush the remaining tail and reset for the next message. */
	finish(width: number): void {
		if (this.text.length === 0) return;
		const lines = this.renderLines(width);
		const remaining = lines.slice(this.committedLines);
		if (remaining.length > 0) this.commit(remaining);
		this.reset();
	}

	reset(): void {
		this.text = "";
		this.committedLines = 0;
		this.lastWidth = 0;
	}
}
