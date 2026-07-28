import { eastAsianWidth } from "get-east-asian-width";

/**
 * Matches CSI sequences (colors, cursor movement), OSC/APC/DCS string
 * sequences (hyperlinks, the cursor marker) and two-character escapes, so
 * they can be stripped or measured as zero-width.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing requires control characters
const ANSI_PATTERN = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b[\]_P^][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * Display width of a string in terminal cells, ignoring ANSI sequences.
 * Handles wide CJK characters, combining marks and emoji sequences.
 */
export function visibleWidth(text: string): number {
	const plain = stripAnsi(text);
	let width = 0;
	for (const char of plain) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		// C0/C1 control characters occupy no cells.
		if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
		// Combining marks and variation selectors attach to the previous cell.
		if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) continue;
		// Zero-width joiner: the joined emoji renders as a single cluster.
		if (code === 0x200d) {
			width -= 2;
			continue;
		}
		width += eastAsianWidth(code, { ambiguousAsWide: false }) === 2 ? 2 : 1;
	}
	return Math.max(0, width);
}

interface AnsiSegment {
	text: string;
	/** Active SGR state at the start of this segment. */
	style: string;
}

/**
 * Split a line into runs of printable text annotated with the SGR state that
 * applies to them, so wrapping and slicing can re-emit styles on new lines.
 */
function segmentByStyle(line: string): AnsiSegment[] {
	const segments: AnsiSegment[] = [];
	let style = "";
	let buffer = "";
	let index = 0;
	ANSI_PATTERN.lastIndex = 0;
	for (const match of line.matchAll(ANSI_PATTERN)) {
		const start = match.index;
		if (start > index) buffer += line.slice(index, start);
		const sequence = match[0];
		// Only SGR sequences carry style; everything else is dropped from layout.
		if (sequence.endsWith("m")) {
			if (buffer) {
				segments.push({ text: buffer, style });
				buffer = "";
			}
			style = sequence === "\x1b[0m" || sequence === "\x1b[m" ? "" : style + sequence;
		}
		index = start + sequence.length;
	}
	if (index < line.length) buffer += line.slice(index);
	if (buffer) segments.push({ text: buffer, style });
	return segments;
}

/** Truncate to `width` display cells, preserving styles and appending `ellipsis` when cut. */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;

	const ellipsisWidth = visibleWidth(ellipsis);
	const budget = Math.max(0, width - ellipsisWidth);
	let out = "";
	let used = 0;
	let style = "";
	for (const segment of segmentByStyle(text)) {
		style = segment.style;
		if (segment.style) out += segment.style;
		for (const char of segment.text) {
			const charWidth = visibleWidth(char);
			if (used + charWidth > budget) {
				return `${out}${ellipsis}${style ? "\x1b[0m" : ""}`;
			}
			out += char;
			used += charWidth;
		}
	}
	return `${out}${ellipsis}${style ? "\x1b[0m" : ""}`;
}

/** Slice a line by display column range, preserving ANSI styles. */
export function sliceByColumn(text: string, start: number, end: number): string {
	let column = 0;
	let out = "";
	let opened = false;
	for (const segment of segmentByStyle(text)) {
		for (const char of segment.text) {
			const charWidth = visibleWidth(char);
			if (column >= end) break;
			if (column >= start) {
				if (segment.style && !opened) {
					out += segment.style;
					opened = true;
				}
				out += char;
			}
			column += charWidth;
		}
	}
	return opened ? `${out}\x1b[0m` : out;
}

/**
 * Word-wrap text to `width` columns. Existing newlines are hard breaks, ANSI
 * styles are carried onto continuation lines, and words longer than the width
 * are split at the column boundary.
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (visibleWidth(rawLine) <= width) {
			out.push(rawLine);
			continue;
		}
		let current = "";
		let currentWidth = 0;
		let style = "";
		const flush = () => {
			out.push(style ? `${current}\x1b[0m` : current);
			current = style;
			currentWidth = 0;
		};
		for (const segment of segmentByStyle(rawLine)) {
			style = segment.style;
			if (segment.style) current += segment.style;
			// Keep trailing whitespace with the preceding word so breaks land between words.
			for (const word of segment.text.split(/(?<=\s)/)) {
				const wordWidth = visibleWidth(word);
				if (currentWidth > 0 && currentWidth + wordWidth > width) flush();
				if (wordWidth > width) {
					for (const char of word) {
						const charWidth = visibleWidth(char);
						if (currentWidth + charWidth > width) flush();
						current += char;
						currentWidth += charWidth;
					}
					continue;
				}
				current += word;
				currentWidth += wordWidth;
			}
		}
		if (visibleWidth(current) > 0) out.push(style ? `${current}\x1b[0m` : current);
	}
	return out.length > 0 ? out : [""];
}

/** Pad a line with spaces to exactly `width` display cells. */
export function padToWidth(text: string, width: number): string {
	const padding = width - visibleWidth(text);
	return padding > 0 ? text + " ".repeat(padding) : text;
}
