import type { Component } from "../tui.ts";
import { visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export interface TextOptions {
	/** Wrap to the viewport width. Defaults to true. */
	wrap?: boolean;
	/** Spaces of left indentation applied to every line. */
	indent?: number;
	/** Prefix drawn on the first line, e.g. a bullet. */
	prefix?: string;
	/** Prefix drawn on continuation lines. Defaults to spaces matching `prefix`. */
	continuationPrefix?: string;
}

/** A block of text, wrapped to the viewport width. */
export class Text implements Component {
	content: string;
	options: TextOptions;

	constructor(content = "", options: TextOptions = {}) {
		this.content = content;
		this.options = options;
	}

	setText(content: string): void {
		this.content = content;
	}

	render(width: number): string[] {
		const { wrap = true, indent = 0, prefix = "" } = this.options;
		const prefixWidth = visibleWidth(prefix);
		const continuation = this.options.continuationPrefix ?? " ".repeat(prefixWidth);
		const pad = " ".repeat(indent);
		const available = Math.max(1, width - indent - prefixWidth);
		const lines = wrap ? wrapTextWithAnsi(this.content, available) : this.content.split("\n");
		return lines.map((line, index) => pad + (index === 0 ? prefix : continuation) + line);
	}
}

/** A blank line, or several. */
export class Spacer implements Component {
	height: number;

	constructor(height = 1) {
		this.height = height;
	}

	render(): string[] {
		return Array.from({ length: this.height }, () => "");
	}
}
