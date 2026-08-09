import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTool } from "@jtui/agent";
import { displayPath, formatBytes, imageMimeType, looksBinary, resolvePath, truncateOutput } from "./common.ts";

/** Largest image forwarded inline; both provider APIs reject much beyond this. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ReadArgs {
	path: string;
	offset?: number;
	limit?: number;
}

/** Read a file with line numbers so the model can cite exact lines. */
export const readTool: AgentTool<ReadArgs> = {
	name: "read",
	description:
		"Read a file from the filesystem. Returns text with line numbers, or the image itself for " +
		"PNG, JPEG, GIF, and WebP files so you can view its contents directly. " +
		"Use offset and limit to page through large files.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the working directory." },
			offset: { type: "number", description: "1-based line number to start from." },
			limit: { type: "number", description: "Maximum number of lines to return. Defaults to 2000." },
		},
		required: ["path"],
	},
	summarize: (args) => `read ${args.path}`,
	async execute(args, context) {
		const path = resolvePath(context.cwd, args.path);
		const info = await stat(path).catch(() => undefined);
		if (!info) return { content: `File not found: ${args.path}`, isError: true };
		if (info.isDirectory()) return { content: `${args.path} is a directory. Use the list tool.`, isError: true };

		const mimeType = imageMimeType(path);
		if (mimeType) {
			if (info.size > MAX_IMAGE_BYTES) {
				return {
					content: `${args.path} is a ${formatBytes(info.size)} image; too large to view (limit ${formatBytes(MAX_IMAGE_BYTES)}).`,
					isError: true,
				};
			}
			const data = (await readFile(path)).toString("base64");
			return {
				content: [
					{ type: "text", text: `Image ${displayPath(context.cwd, path)} (${formatBytes(info.size)}):` },
					{ type: "image", data, mimeType },
				],
				details: { path, image: true },
			};
		}

		const buffer = await readFile(path);
		if (looksBinary(buffer)) {
			return { content: `${args.path} is a binary file (${formatBytes(info.size)}).`, isError: true };
		}

		const lines = buffer.toString("utf8").split("\n");
		const offset = Math.max(1, args.offset ?? 1);
		const limit = Math.max(1, args.limit ?? 2000);
		const selected = lines.slice(offset - 1, offset - 1 + limit);
		if (selected.length === 0) {
			return { content: `Line ${offset} is past the end of the file (${lines.length} lines).`, isError: true };
		}

		const width = String(offset + selected.length - 1).length;
		const numbered = selected.map((line, index) => `${String(offset + index).padStart(width)}\t${line}`).join("\n");
		const footer =
			offset - 1 + selected.length < lines.length
				? `\n\n… ${lines.length - (offset - 1 + selected.length)} more lines. Continue with offset ${offset + selected.length}.`
				: "";
		return {
			content: truncateOutput(numbered) + footer,
			details: { path, lines: lines.length },
		};
	},
};

interface WriteArgs {
	path: string;
	content: string;
}

/** Create or overwrite a file. */
export const writeTool: AgentTool<WriteArgs> = {
	name: "write",
	description:
		"Write content to a file, creating parent directories as needed. Overwrites the file if it already exists. " +
		"Prefer the edit tool for changing part of an existing file.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path to write." },
			content: { type: "string", description: "Full content of the file." },
		},
		required: ["path", "content"],
	},
	summarize: (args) => `write ${args.path}`,
	async execute(args, context) {
		const path = resolvePath(context.cwd, args.path);
		const existed = await stat(path).then(
			(info) => info.isFile(),
			() => false,
		);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, args.content, "utf8");
		const lines = args.content.split("\n").length;
		return {
			content: `${existed ? "Updated" : "Created"} ${displayPath(context.cwd, path)} (${lines} lines, ${formatBytes(Buffer.byteLength(args.content))}).`,
			details: { path, created: !existed },
		};
	},
};

interface EditArgs {
	path: string;
	old_text: string;
	new_text: string;
	replace_all?: boolean;
}

/** Exact string replacement, refusing ambiguous matches. */
export const editTool: AgentTool<EditArgs> = {
	name: "edit",
	description:
		"Replace an exact string in a file. The old_text must appear exactly once unless replace_all is true. " +
		"Include enough surrounding context to make the match unique.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File to edit." },
			old_text: { type: "string", description: "Exact text to replace, including indentation." },
			new_text: { type: "string", description: "Replacement text." },
			replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
		},
		required: ["path", "old_text", "new_text"],
	},
	summarize: (args) => `edit ${args.path}`,
	async execute(args, context) {
		const path = resolvePath(context.cwd, args.path);
		const original = await readFile(path, "utf8").catch(() => undefined);
		if (original === undefined) return { content: `File not found: ${args.path}`, isError: true };
		if (args.old_text === args.new_text) {
			return { content: "old_text and new_text are identical; nothing to do.", isError: true };
		}

		const occurrences = original.split(args.old_text).length - 1;
		if (occurrences === 0) {
			return {
				content: `old_text not found in ${args.path}. The file may have changed; read it again before editing.`,
				isError: true,
			};
		}
		if (occurrences > 1 && !args.replace_all) {
			return {
				content: `old_text appears ${occurrences} times in ${args.path}. Add surrounding context to make it unique, or set replace_all.`,
				isError: true,
			};
		}

		const updated = args.replace_all
			? original.split(args.old_text).join(args.new_text)
			: original.replace(args.old_text, args.new_text);
		await writeFile(path, updated, "utf8");
		return {
			content: `Edited ${displayPath(context.cwd, path)} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`,
			details: { path, occurrences },
		};
	},
};

interface ListArgs {
	path?: string;
}

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

/** List one directory level. */
export const listTool: AgentTool<ListArgs> = {
	name: "list",
	description: "List the contents of a directory. Directories are marked with a trailing slash.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list. Defaults to the working directory." },
		},
	},
	summarize: (args) => `list ${args.path ?? "."}`,
	async execute(args, context) {
		const path = resolvePath(context.cwd, args.path ?? ".");
		const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
		if (!entries) return { content: `Directory not found: ${args.path ?? "."}`, isError: true };

		const rows = await Promise.all(
			entries
				.filter((entry) => !entry.name.startsWith("."))
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
				.map(async (entry) => {
					if (entry.isDirectory())
						return `${entry.name}/${IGNORED_DIRECTORIES.has(entry.name) ? "  (skipped by search)" : ""}`;
					const info = await stat(join(path, entry.name)).catch(() => undefined);
					return `${entry.name}${info ? `  ${formatBytes(info.size)}` : ""}`;
				}),
		);
		if (rows.length === 0) return { content: `${displayPath(context.cwd, path)} is empty.` };
		return { content: truncateOutput(rows.join("\n")), details: { path, count: rows.length } };
	},
};
