/**
 * Minimal SGR styling helpers. Colours degrade to no-ops when the output is
 * not a TTY or when NO_COLOR is set.
 */

const RESET = "\x1b[0m";

function colorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0";
	return process.stdout.isTTY === true;
}

let enabled = colorEnabled();

/** Force colour output on or off, overriding environment detection. */
export function setColorEnabled(value: boolean): void {
	enabled = value;
}

function sgr(open: string): (text: string) => string {
	return (text: string) => (enabled ? `${open}${text}${RESET}` : text);
}

export const bold = sgr("\x1b[1m");
export const dim = sgr("\x1b[2m");
export const italic = sgr("\x1b[3m");
export const underline = sgr("\x1b[4m");
export const inverse = sgr("\x1b[7m");
export const strikethrough = sgr("\x1b[9m");

export const black = sgr("\x1b[30m");
export const red = sgr("\x1b[31m");
export const green = sgr("\x1b[32m");
export const yellow = sgr("\x1b[33m");
export const blue = sgr("\x1b[34m");
export const magenta = sgr("\x1b[35m");
export const cyan = sgr("\x1b[36m");
export const white = sgr("\x1b[37m");
export const gray = sgr("\x1b[90m");

export const bgRed = sgr("\x1b[41m");
export const bgGreen = sgr("\x1b[42m");
export const bgYellow = sgr("\x1b[43m");
export const bgBlue = sgr("\x1b[44m");

/** 256-colour foreground. */
export function color256(code: number): (text: string) => string {
	return sgr(`\x1b[38;5;${code}m`);
}

/** 24-bit foreground. */
export function rgb(r: number, g: number, b: number): (text: string) => string {
	return sgr(`\x1b[38;2;${r};${g};${b}m`);
}
