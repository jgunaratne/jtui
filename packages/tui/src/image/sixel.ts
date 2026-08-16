import type { RgbaImage } from "./png.ts";

/** Sixel encodes six vertical pixels per character cell row. */
const BAND_HEIGHT = 6;

/** Terminals are required to support at least 256 palette registers. */
const MAX_COLORS = 256;

export interface SixelOptions {
	/** Largest width in pixels; the image is scaled down to fit. */
	maxWidth?: number;
	/** Largest height in pixels. */
	maxHeight?: number;
	/** Palette size, capped at 256. */
	colors?: number;
	/** Colour composited under transparent pixels. Defaults to black. */
	background?: [number, number, number];
}

/** Box-filter downscale. Averaging avoids the shimmer nearest-neighbour gives. */
export function resize(image: RgbaImage, width: number, height: number): RgbaImage {
	if (width === image.width && height === image.height) return image;
	const pixels = new Uint8Array(width * height * 4);
	const xRatio = image.width / width;
	const yRatio = image.height / height;

	for (let y = 0; y < height; y++) {
		const startY = Math.floor(y * yRatio);
		const endY = Math.max(startY + 1, Math.floor((y + 1) * yRatio));
		for (let x = 0; x < width; x++) {
			const startX = Math.floor(x * xRatio);
			const endX = Math.max(startX + 1, Math.floor((x + 1) * xRatio));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;
			for (let sy = startY; sy < endY && sy < image.height; sy++) {
				for (let sx = startX; sx < endX && sx < image.width; sx++) {
					const source = (sy * image.width + sx) * 4;
					r += image.pixels[source] ?? 0;
					g += image.pixels[source + 1] ?? 0;
					b += image.pixels[source + 2] ?? 0;
					a += image.pixels[source + 3] ?? 0;
					count++;
				}
			}
			const target = (y * width + x) * 4;
			const divisor = count || 1;
			pixels[target] = Math.round(r / divisor);
			pixels[target + 1] = Math.round(g / divisor);
			pixels[target + 2] = Math.round(b / divisor);
			pixels[target + 3] = Math.round(a / divisor);
		}
	}
	return { width, height, pixels };
}

interface Box {
	pixels: number[];
	min: [number, number, number];
	max: [number, number, number];
}

function boundsOf(pixels: number[], rgb: Uint8Array): Box {
	const min: [number, number, number] = [255, 255, 255];
	const max: [number, number, number] = [0, 0, 0];
	for (const index of pixels) {
		for (let channel = 0; channel < 3; channel++) {
			const value = rgb[index * 3 + channel] ?? 0;
			if (value < (min[channel] ?? 255)) min[channel] = value;
			if (value > (max[channel] ?? 0)) max[channel] = value;
		}
	}
	return { pixels, min, max };
}

/**
 * Median-cut quantization.
 *
 * Repeatedly splits the box with the widest colour spread at its median along
 * that axis, which keeps detail where the image actually varies instead of
 * spending registers on a uniform background.
 */
function quantize(rgb: Uint8Array, count: number, limit: number): { palette: number[][]; lookup: Uint8Array } {
	const all = Array.from({ length: count }, (_, index) => index);
	let boxes = [boundsOf(all, rgb)];

	while (boxes.length < limit) {
		let target = -1;
		let widest = 0;
		let axis = 0;
		for (let index = 0; index < boxes.length; index++) {
			const box = boxes[index];
			if (!box || box.pixels.length < 2) continue;
			for (let channel = 0; channel < 3; channel++) {
				const spread = (box.max[channel] ?? 0) - (box.min[channel] ?? 0);
				if (spread > widest) {
					widest = spread;
					target = index;
					axis = channel;
				}
			}
		}
		if (target === -1 || widest === 0) break;

		const box = boxes[target];
		if (!box) break;
		const sorted = [...box.pixels].sort((a, b) => (rgb[a * 3 + axis] ?? 0) - (rgb[b * 3 + axis] ?? 0));
		const middle = sorted.length >> 1;
		boxes = [
			...boxes.slice(0, target),
			boundsOf(sorted.slice(0, middle), rgb),
			boundsOf(sorted.slice(middle), rgb),
			...boxes.slice(target + 1),
		];
	}

	const palette = boxes.map((box) => {
		let r = 0;
		let g = 0;
		let b = 0;
		for (const index of box.pixels) {
			r += rgb[index * 3] ?? 0;
			g += rgb[index * 3 + 1] ?? 0;
			b += rgb[index * 3 + 2] ?? 0;
		}
		const size = box.pixels.length || 1;
		return [Math.round(r / size), Math.round(g / size), Math.round(b / size)];
	});

	const lookup = new Uint8Array(count);
	for (let index = 0; index < boxes.length; index++) {
		for (const pixel of boxes[index]?.pixels ?? []) lookup[pixel] = index;
	}
	return { palette, lookup };
}

/** Scale to fit inside the given bounds, never enlarging. */
export function fit(image: RgbaImage, maxWidth?: number, maxHeight?: number): { width: number; height: number } {
	const scale = Math.min(
		maxWidth ? maxWidth / image.width : 1,
		maxHeight ? maxHeight / image.height : 1,
		1, // Upscaling only wastes bytes.
	);
	return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
}

/**
 * Encode an image as a sixel escape sequence.
 *
 * The format writes one band of six pixel rows at a time: for each colour used
 * in the band, a run of characters whose low six bits say which of the six rows
 * that column paints. `$` returns to the start of the band to overlay the next
 * colour, `-` moves to the next band.
 */
export function encodeSixel(image: RgbaImage, options: SixelOptions = {}): string {
	const target = fit(image, options.maxWidth, options.maxHeight);
	const scaled = resize(image, target.width, target.height);
	const { width, height } = scaled;
	const background = options.background ?? [0, 0, 0];

	// Flatten alpha first: sixel has no transparency of its own.
	const rgb = new Uint8Array(width * height * 3);
	for (let index = 0; index < width * height; index++) {
		const alpha = (scaled.pixels[index * 4 + 3] ?? 255) / 255;
		for (let channel = 0; channel < 3; channel++) {
			const value = scaled.pixels[index * 4 + channel] ?? 0;
			rgb[index * 3 + channel] = Math.round(value * alpha + (background[channel] ?? 0) * (1 - alpha));
		}
	}

	const limit = Math.min(options.colors ?? MAX_COLORS, MAX_COLORS);
	const { palette, lookup } = quantize(rgb, width * height, limit);

	const out: string[] = ["\x1bP0;1;0q", `"1;1;${width};${height}`];
	for (let index = 0; index < palette.length; index++) {
		const [r = 0, g = 0, b = 0] = palette[index] ?? [];
		// Sixel colour components are percentages, not 0-255.
		const percent = (value: number) => Math.round((value * 100) / 255);
		out.push(`#${index};2;${percent(r)};${percent(g)};${percent(b)}`);
	}

	for (let top = 0; top < height; top += BAND_HEIGHT) {
		const rows = Math.min(BAND_HEIGHT, height - top);
		// Which colours appear in this band, so unused ones cost nothing.
		const present = new Set<number>();
		for (let y = top; y < top + rows; y++) {
			for (let x = 0; x < width; x++) present.add(lookup[y * width + x] ?? 0);
		}

		let first = true;
		for (const color of present) {
			out.push(first ? `#${color}` : `$#${color}`);
			first = false;
			let runChar = -1;
			let runLength = 0;
			const flush = () => {
				if (runLength === 0) return;
				const char = String.fromCharCode(63 + runChar);
				// Run-length encoding pays for itself beyond three repeats.
				out.push(runLength > 3 ? `!${runLength}${char}` : char.repeat(runLength));
				runLength = 0;
			};
			for (let x = 0; x < width; x++) {
				let bits = 0;
				for (let row = 0; row < rows; row++) {
					if ((lookup[(top + row) * width + x] ?? 0) === color) bits |= 1 << row;
				}
				if (bits === runChar) runLength++;
				else {
					flush();
					runChar = bits;
					runLength = 1;
				}
			}
			flush();
		}
		out.push("-");
	}

	out.push("\x1b\\");
	return out.join("");
}
