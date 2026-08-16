import { inflateSync } from "node:zlib";

/** A decoded image as straight 8-bit RGBA, row-major, no padding. */
export interface RgbaImage {
	width: number;
	height: number;
	/** `width * height * 4` bytes. */
	pixels: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels carried per pixel for each PNG colour type. */
const CHANNELS: Partial<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Header {
	width: number;
	height: number;
	bitDepth: number;
	colorType: number;
	interlace: number;
}

export class PngError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PngError";
	}
}

function readHeader(data: Buffer, offset: number): Header {
	return {
		width: data.readUInt32BE(offset),
		height: data.readUInt32BE(offset + 4),
		bitDepth: data[offset + 8] ?? 0,
		colorType: data[offset + 9] ?? 0,
		interlace: data[offset + 12] ?? 0,
	};
}

/** Undo the per-scanline filter PNG applies before compression. */
function unfilter(raw: Buffer, header: Header, bytesPerPixel: number, bytesPerRow: number): Buffer {
	const out = Buffer.alloc(header.height * bytesPerRow);
	let position = 0;
	for (let y = 0; y < header.height; y++) {
		const filter = raw[position++] ?? 0;
		const rowStart = y * bytesPerRow;
		const priorStart = rowStart - bytesPerRow;
		for (let x = 0; x < bytesPerRow; x++) {
			const value = raw[position++] ?? 0;
			const left = x >= bytesPerPixel ? (out[rowStart + x - bytesPerPixel] ?? 0) : 0;
			const up = y > 0 ? (out[priorStart + x] ?? 0) : 0;
			const upLeft = y > 0 && x >= bytesPerPixel ? (out[priorStart + x - bytesPerPixel] ?? 0) : 0;
			let restored: number;
			switch (filter) {
				case 0:
					restored = value;
					break;
				case 1:
					restored = value + left;
					break;
				case 2:
					restored = value + up;
					break;
				case 3:
					restored = value + ((left + up) >> 1);
					break;
				case 4: {
					// Paeth: pick whichever neighbour the gradient predicts.
					const estimate = left + up - upLeft;
					const dLeft = Math.abs(estimate - left);
					const dUp = Math.abs(estimate - up);
					const dUpLeft = Math.abs(estimate - upLeft);
					restored = value + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft);
					break;
				}
				default:
					throw new PngError(`Unsupported PNG filter ${filter}`);
			}
			out[rowStart + x] = restored & 0xff;
		}
	}
	return out;
}

/** Read one channel value, normalising any bit depth to 0-255. */
function sampleAt(row: Buffer, index: number, bitDepth: number): number {
	if (bitDepth === 8) return row[index] ?? 0;
	if (bitDepth === 16) return row[index * 2] ?? 0; // Take the high byte.
	const perByte = 8 / bitDepth;
	const byte = row[Math.floor(index / perByte)] ?? 0;
	const shift = 8 - bitDepth * ((index % perByte) + 1);
	const value = (byte >> shift) & ((1 << bitDepth) - 1);
	// Scale the reduced range up so 1-bit black/white becomes 0/255.
	return Math.round((value * 255) / ((1 << bitDepth) - 1));
}

/**
 * Decode a PNG to RGBA.
 *
 * Covers the non-interlaced colour types a model returns — greyscale, RGB,
 * palette and their alpha variants, at any bit depth. Interlaced files are
 * rejected rather than decoded wrongly; nothing generates them here.
 */
export function decodePng(input: Uint8Array): RgbaImage {
	const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	if (data.length < 8 || !SIGNATURE.every((byte, index) => data[index] === byte)) {
		throw new PngError("Not a PNG file");
	}

	let header: Header | undefined;
	let palette: Buffer | undefined;
	let transparency: Buffer | undefined;
	const chunks: Buffer[] = [];

	let offset = 8;
	while (offset + 8 <= data.length) {
		const length = data.readUInt32BE(offset);
		const type = data.toString("ascii", offset + 4, offset + 8);
		const body = data.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") header = readHeader(data, offset + 8);
		else if (type === "PLTE") palette = Buffer.from(body);
		else if (type === "tRNS") transparency = Buffer.from(body);
		else if (type === "IDAT") chunks.push(Buffer.from(body));
		else if (type === "IEND") break;
		// Skip the 4-byte CRC that follows every chunk body.
		offset += 12 + length;
	}

	if (!header) throw new PngError("PNG has no IHDR chunk");
	if (header.interlace !== 0) throw new PngError("Interlaced PNG is not supported");
	if (chunks.length === 0) throw new PngError("PNG has no image data");
	const channels = CHANNELS[header.colorType];
	if (channels === undefined) throw new PngError(`Unsupported PNG colour type ${header.colorType}`);
	if (header.colorType === 3 && !palette) throw new PngError("Indexed PNG has no palette");

	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(chunks));
	} catch (error) {
		// A zlib code like Z_BUF_ERROR means nothing to a caller printing this.
		throw new PngError(`PNG data could not be decompressed: ${(error as Error).message}`);
	}
	const bitsPerPixel = channels * header.bitDepth;
	const bytesPerRow = Math.ceil((bitsPerPixel * header.width) / 8);
	// Filters operate on whole bytes, so sub-byte pixels step by one.
	const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
	const expected = header.height * (bytesPerRow + 1);
	if (raw.length < expected) throw new PngError("PNG data is truncated");

	const restored = unfilter(raw, header, bytesPerPixel, bytesPerRow);
	const pixels = new Uint8Array(header.width * header.height * 4);

	for (let y = 0; y < header.height; y++) {
		const row = restored.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
		for (let x = 0; x < header.width; x++) {
			const base = channels * x;
			let r: number;
			let g: number;
			let b: number;
			let a = 255;
			if (header.colorType === 3) {
				const index = sampleAtIndex(row, x, header.bitDepth);
				r = palette?.[index * 3] ?? 0;
				g = palette?.[index * 3 + 1] ?? 0;
				b = palette?.[index * 3 + 2] ?? 0;
				a = transparency?.[index] ?? 255;
			} else if (header.colorType === 0 || header.colorType === 4) {
				r = sampleAt(row, base, header.bitDepth);
				g = r;
				b = r;
				if (header.colorType === 4) a = sampleAt(row, base + 1, header.bitDepth);
			} else {
				r = sampleAt(row, base, header.bitDepth);
				g = sampleAt(row, base + 1, header.bitDepth);
				b = sampleAt(row, base + 2, header.bitDepth);
				if (header.colorType === 6) a = sampleAt(row, base + 3, header.bitDepth);
			}
			const target = (y * header.width + x) * 4;
			pixels[target] = r;
			pixels[target + 1] = g;
			pixels[target + 2] = b;
			pixels[target + 3] = a;
		}
	}

	return { width: header.width, height: header.height, pixels };
}

/** Palette indices are raw values, not scaled to 0-255 like colour samples. */
function sampleAtIndex(row: Buffer, x: number, bitDepth: number): number {
	if (bitDepth === 8) return row[x] ?? 0;
	const perByte = 8 / bitDepth;
	const byte = row[Math.floor(x / perByte)] ?? 0;
	const shift = 8 - bitDepth * ((x % perByte) + 1);
	return (byte >> shift) & ((1 << bitDepth) - 1);
}
