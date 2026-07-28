import { bold, cyan, dim, gray, green, italic, strikethrough, underline, yellow } from "../styles.ts";
import type { Component } from "../tui.ts";
import { visibleWidth, wrapTextWithAnsi } from "../utils.ts";

/** Apply inline markdown emphasis, code spans and links. */
export function renderInline(text: string): string {
	return (
		text
			// Code spans first so their contents are not re-processed.
			.replace(/`([^`]+)`/g, (_, code: string) => green(code))
			.replace(/\*\*\*([^*]+)\*\*\*/g, (_, inner: string) => bold(italic(inner)))
			.replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => bold(inner))
			.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, inner: string) => italic(inner))
			.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_, inner: string) => italic(inner))
			.replace(/~~([^~]+)~~/g, (_, inner: string) => strikethrough(inner))
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => `${underline(label)} ${dim(`(${url})`)}`)
	);
}

const HEADING_STYLES = [
	(text: string) => bold(cyan(text)),
	(text: string) => bold(cyan(text)),
	(text: string) => bold(text),
	(text: string) => bold(dim(text)),
];

/**
 * Render markdown to styled terminal lines.
 *
 * This is a line-oriented renderer covering the constructs a coding agent
 * actually emits: fenced code, headings, lists, quotes, rules and tables are
 * left intact rather than reflowed.
 */
export function renderMarkdown(markdown: string, width: number): string[] {
	const out: string[] = [];
	const lines = markdown.split("\n");
	let inCodeBlock = false;
	let codeLanguage = "";

	for (const line of lines) {
		const fence = /^\s*```(.*)$/.exec(line);
		if (fence) {
			if (inCodeBlock) {
				inCodeBlock = false;
				codeLanguage = "";
			} else {
				inCodeBlock = true;
				codeLanguage = (fence[1] ?? "").trim();
				if (codeLanguage) out.push(dim(`  ${codeLanguage}`));
			}
			continue;
		}
		if (inCodeBlock) {
			// Code is never reflowed; long lines are left to the terminal.
			out.push(`${gray("│ ")}${green(line)}`);
			continue;
		}

		if (line.trim().length === 0) {
			out.push("");
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = Math.min((heading[1] ?? "#").length, HEADING_STYLES.length) - 1;
			const style = HEADING_STYLES[level] ?? bold;
			out.push(...wrapTextWithAnsi(style(renderInline(heading[2] ?? "")), width));
			continue;
		}

		if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
			out.push(dim("─".repeat(Math.max(1, Math.min(width, 40)))));
			continue;
		}

		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			const body = wrapTextWithAnsi(dim(renderInline(quote[1] ?? "")), Math.max(1, width - 2));
			out.push(...body.map((row) => `${gray("│ ")}${row}`));
			continue;
		}

		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			const indent = (bullet[1] ?? "").length;
			const marker = `${" ".repeat(indent)}${cyan("•")} `;
			const body = wrapTextWithAnsi(renderInline(bullet[2] ?? ""), Math.max(1, width - indent - 2));
			out.push(...body.map((row, index) => (index === 0 ? marker + row : `${" ".repeat(indent + 2)}${row}`)));
			continue;
		}

		const numbered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
		if (numbered) {
			const indent = (numbered[1] ?? "").length;
			const marker = `${" ".repeat(indent)}${yellow(`${numbered[2]}.`)} `;
			const markerWidth = visibleWidth(marker);
			const body = wrapTextWithAnsi(renderInline(numbered[4] ?? ""), Math.max(1, width - markerWidth));
			out.push(...body.map((row, index) => (index === 0 ? marker + row : `${" ".repeat(markerWidth)}${row}`)));
			continue;
		}

		out.push(...wrapTextWithAnsi(renderInline(line), width));
	}
	return out;
}

/** A block of markdown rendered to styled terminal lines. */
export class Markdown implements Component {
	content: string;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(content = "") {
		this.content = content;
	}

	setContent(content: string): void {
		if (content === this.content) return;
		this.content = content;
		this.cache = undefined;
	}

	append(chunk: string): void {
		this.content += chunk;
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines = renderMarkdown(this.content, width);
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
