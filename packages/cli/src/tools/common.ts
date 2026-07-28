import { isAbsolute, relative, resolve } from "node:path";

/** Maximum characters returned to the model from a single tool. */
export const MAX_TOOL_OUTPUT = 30_000;

/** Trim output to a token-sane size, keeping both ends of long content. */
export function truncateOutput(text: string, limit = MAX_TOOL_OUTPUT): string {
	if (text.length <= limit) return text;
	const half = Math.floor(limit / 2);
	const omitted = text.length - limit;
	return `${text.slice(0, half)}\n\n… ${omitted} characters truncated …\n\n${text.slice(-half)}`;
}

/**
 * Resolve a tool path argument against the session directory.
 *
 * Paths outside the working directory are allowed but reported as absolute, so
 * the model can see when it is reaching outside the project.
 */
export function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** Render a path relative to `cwd` when it is inside it. */
export function displayPath(cwd: string, path: string): string {
	const relativePath = relative(cwd, path);
	return relativePath.startsWith("..") || isAbsolute(relativePath) ? path : relativePath || ".";
}

/** Format a byte count for humans. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Heuristic binary check so the agent never dumps binary into context. */
export function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 4096);
	for (const byte of sample) {
		if (byte === 0) return true;
	}
	return false;
}
