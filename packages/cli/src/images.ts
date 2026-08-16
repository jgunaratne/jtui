import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@jtui/ai";
import { renderImage, styles } from "@jtui/tui";
import { projectConfigDir } from "./config.ts";

const { dim, yellow } = styles;

/** Where a generated image is written when it cannot be drawn. */
export function imagesDir(cwd: string): string {
	return join(projectConfigDir(cwd), "images");
}

function extensionFor(mimeType: string): string {
	const subtype = mimeType.split("/")[1] ?? "png";
	return subtype.replace(/[^a-z0-9]/gi, "") || "png";
}

/** Write the image to the project directory and return its path. */
export function saveImage(image: ImageContent, cwd: string, now = Date.now()): string {
	const directory = imagesDir(cwd);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${now}.${extensionFor(image.mimeType)}`);
	writeFileSync(path, Buffer.from(image.data, "base64"));
	return path;
}

export interface ImageRenderOptions {
	cwd: string;
	columns?: number | undefined;
	rows?: number | undefined;
	/** Force sixel on or off instead of detecting from the environment. */
	sixel?: boolean | undefined;
}

/**
 * Turn a generated image into lines to print.
 *
 * The image is always written to disk: a terminal that draws it still leaves
 * nothing to reopen afterwards, and scrollback loses it. When the terminal
 * cannot draw it, the path is the whole answer.
 */
export function renderGeneratedImage(image: ImageContent, options: ImageRenderOptions): string[] {
	const bytes = Buffer.from(image.data, "base64");
	let path: string | undefined;
	try {
		path = saveImage(image, options.cwd);
	} catch (error) {
		// A read-only directory should not cost the image entirely; it may still
		// be drawable below.
		path = undefined;
		if (!options.sixel) return [yellow(`Could not save generated image: ${(error as Error).message}`)];
	}

	try {
		const rendered = renderImage(bytes, image.mimeType, {
			...(options.columns !== undefined ? { columns: options.columns } : {}),
			...(options.rows !== undefined ? { rows: options.rows } : {}),
			...(options.sixel !== undefined ? { sixel: options.sixel } : {}),
		});
		const caption = dim(`image ${rendered.width}×${rendered.height}${path ? ` · ${path}` : ""}`);
		if (rendered.escape) return [rendered.escape, caption];
		return [dim(`[image ${rendered.width}×${rendered.height}, ${bytes.length} bytes]`), caption];
	} catch (error) {
		// An undecodable image is still on disk, so say where rather than fail.
		const detail = (error as Error).message;
		return [yellow(`Could not draw generated image: ${detail}`), ...(path ? [dim(path)] : [])];
	}
}
