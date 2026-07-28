import { dim } from "../styles.ts";
import type { Component } from "../tui.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface LoaderOptions {
	/** Text shown next to the spinner. */
	label?: string;
	/** Frame interval in milliseconds. */
	intervalMs?: number;
	/** Called on each frame so the host can request a render. */
	onFrame?: () => void;
}

/** Animated spinner. Call {@link start} to begin ticking. */
export class Loader implements Component {
	label: string;
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;
	private readonly intervalMs: number;
	private readonly onFrame: (() => void) | undefined;
	private startedAt = 0;

	constructor(options: LoaderOptions = {}) {
		this.label = options.label ?? "Working";
		this.intervalMs = options.intervalMs ?? 80;
		this.onFrame = options.onFrame;
	}

	start(): void {
		if (this.timer) return;
		this.startedAt = Date.now();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES.length;
			this.onFrame?.();
		}, this.intervalMs);
		// Never hold the process open for an animation.
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	get running(): boolean {
		return this.timer !== undefined;
	}

	render(): string[] {
		if (!this.timer) return [];
		const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
		const suffix = elapsed > 0 ? dim(` (${elapsed}s · esc to interrupt)`) : "";
		return [`${FRAMES[this.frame]} ${this.label}${suffix}`];
	}
}
