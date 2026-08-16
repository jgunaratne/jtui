import { decodePng, PngError, type RgbaImage } from "./png.ts";
import { encodeSixel, fit, type SixelOptions } from "./sixel.ts";

export { decodePng, PngError, type RgbaImage } from "./png.ts";
export { encodeSixel, fit, resize, type SixelOptions } from "./sixel.ts";

/** Rough cell size in pixels, used to convert a column budget to a width. */
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;

export interface TerminalEnv {
	TERM?: string | undefined;
	TERM_PROGRAM?: string | undefined;
	LC_TERMINAL?: string | undefined;
	KONSOLE_VERSION?: string | undefined;
	WT_SESSION?: string | undefined;
	VTE_VERSION?: string | undefined;
}

/**
 * Whether the terminal is expected to render sixel.
 *
 * There is no reliable synchronous probe: the definitive test is a DA1 query,
 * which needs a raw-mode read and a timeout, and inside tmux answers for tmux
 * rather than the outer terminal. Identifying known-good terminals by
 * environment is less precise but never hangs, and the cost of being wrong is
 * a fallback to a saved file rather than a corrupted screen.
 */
export function supportsSixel(env: TerminalEnv = process.env): boolean {
	const term = env.TERM ?? "";
	// A terminal that advertises sixel in TERM settles it either way.
	if (/sixel/i.test(term)) return true;
	if (term === "dumb" || term === "") return false;

	// tmux 3.4+ parses sixel itself and repaints it, so passthrough is neither
	// needed nor wanted. It still only shows if the outer terminal can draw it.
	//
	// Both variables must be consulted, not one in preference to the other:
	// inside tmux TERM_PROGRAM becomes "tmux" and hides the real terminal, while
	// LC_TERMINAL is set by iTerm2 and survives both ssh and tmux.
	const program = `${env.TERM_PROGRAM ?? ""} ${env.LC_TERMINAL ?? ""}`;
	if (/iTerm|WezTerm|kitty|ghostty|contour|foot|mlterm/i.test(program)) return true;
	if (env.KONSOLE_VERSION) return true;
	if (/^(foot|contour|mlterm|yaft|xterm-kitty)/.test(term)) return true;
	return false;
}

export interface RenderImageOptions extends SixelOptions {
	/** Terminal width in columns, used to bound the image. */
	columns?: number;
	/** Terminal height in rows. */
	rows?: number;
	/** Force sixel on or off instead of detecting. */
	sixel?: boolean;
	env?: TerminalEnv;
}

export interface RenderedImage {
	/** Escape sequence to write, when the terminal can draw the image. */
	escape?: string;
	/** Pixel size actually emitted. */
	width: number;
	height: number;
	/** Rows the image occupies, so a caller can reserve vertical space. */
	rows: number;
}

/** Decode a supported image format to RGBA. */
export function decodeImage(data: Uint8Array, mimeType: string): RgbaImage {
	if (/png/i.test(mimeType)) return decodePng(data);
	// PNG is what the image models return; anything else needs a real codec.
	throw new PngError(`Cannot decode ${mimeType} — only PNG is supported`);
}

/**
 * Turn image bytes into something writable to the terminal.
 *
 * Returns no escape when the terminal cannot draw images, leaving the caller to
 * fall back to writing the file out and naming the path.
 */
export function renderImage(data: Uint8Array, mimeType: string, options: RenderImageOptions = {}): RenderedImage {
	const image = decodeImage(data, mimeType);
	const enabled = options.sixel ?? supportsSixel(options.env ?? process.env);

	// Leave a column's margin so a rounded-up cell cannot wrap the line.
	const maxWidth =
		options.maxWidth ?? (options.columns ? Math.max(CELL_WIDTH, (options.columns - 1) * CELL_WIDTH) : undefined);
	// Keep the image to about half the viewport so the conversation stays visible.
	const maxHeight =
		options.maxHeight ?? (options.rows ? Math.max(CELL_HEIGHT, Math.floor(options.rows / 2) * CELL_HEIGHT) : undefined);
	const target = fit(image, maxWidth, maxHeight);
	const rows = Math.ceil(target.height / CELL_HEIGHT);

	if (!enabled) return { width: target.width, height: target.height, rows };
	const sixel = encodeSixel(image, { ...options, maxWidth, maxHeight });
	return { escape: sixel, width: target.width, height: target.height, rows };
}
