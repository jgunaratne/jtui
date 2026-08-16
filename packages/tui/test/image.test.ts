import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { supportsSixel } from "../src/image/index.ts";
import { decodePng, PngError } from "../src/image/png.ts";
import { encodeSixel, fit, resize } from "../src/image/sixel.ts";

/** Build a minimal valid PNG so decoding is tested against real bytes. */
function makePng(width: number, height: number, rgba: number[][], colorType = 6, bitDepth = 8): Uint8Array {
	const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
	const bytesPerRow = Math.ceil((channels * bitDepth * width) / 8);
	const raw = Buffer.alloc(height * (bytesPerRow + 1));
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0; // Filter: none.
		for (let x = 0; x < width; x++) {
			const pixel = rgba[y * width + x] ?? [0, 0, 0, 255];
			for (let channel = 0; channel < channels; channel++) raw[offset++] = pixel[channel] ?? 0;
		}
	}

	const chunk = (type: string, body: Buffer): Buffer => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(body.length);
		const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
		// The decoder skips CRCs, so a zero placeholder is enough here.
		return Buffer.concat([length, typed, Buffer.alloc(4)]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;

	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

describe("decodePng", () => {
	it("decodes an RGBA image to the right pixels", () => {
		const png = makePng(2, 1, [
			[255, 0, 0, 255],
			[0, 255, 0, 128],
		]);
		const image = decodePng(png);
		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect([...image.pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
	});

	it("decodes RGB without an alpha channel as opaque", () => {
		const image = decodePng(makePng(1, 1, [[10, 20, 30]], 2));
		expect([...image.pixels]).toEqual([10, 20, 30, 255]);
	});

	it("expands greyscale into all three channels", () => {
		const image = decodePng(makePng(1, 1, [[77]], 0));
		expect([...image.pixels]).toEqual([77, 77, 77, 255]);
	});

	it("rejects a file that is not a PNG", () => {
		expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(PngError);
	});

	it("rejects an interlaced PNG rather than decoding it wrongly", () => {
		const png = makePng(1, 1, [[0, 0, 0, 255]]);
		png[8 + 8 + 12] = 1; // Interlace byte inside IHDR.
		expect(() => decodePng(png)).toThrow(/nterlaced/);
	});

	it("reports a truncated file instead of returning garbage", () => {
		const png = makePng(
			4,
			4,
			Array.from({ length: 16 }, () => [1, 2, 3, 4]),
		);
		expect(() => decodePng(png.slice(0, png.length - 30))).toThrow(PngError);
	});
});

describe("fit", () => {
	const image = { width: 1000, height: 500, pixels: new Uint8Array(0) };

	it("scales down to the width budget, preserving aspect", () => {
		expect(fit(image, 100)).toEqual({ width: 100, height: 50 });
	});

	it("honours whichever bound binds first", () => {
		expect(fit(image, 100, 20)).toEqual({ width: 40, height: 20 });
	});

	it("never enlarges a small image", () => {
		expect(fit({ width: 10, height: 10, pixels: new Uint8Array(0) }, 500, 500)).toEqual({ width: 10, height: 10 });
	});
});

describe("resize", () => {
	it("averages source pixels rather than dropping them", () => {
		const image = {
			width: 2,
			height: 1,
			pixels: new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255]),
		};
		const out = resize(image, 1, 1);
		expect([...out.pixels]).toEqual([50, 50, 50, 255]);
	});
});

describe("encodeSixel", () => {
	const red = { width: 6, height: 6, pixels: new Uint8Array(6 * 6 * 4) };
	for (let index = 0; index < 36; index++) {
		red.pixels[index * 4] = 255;
		red.pixels[index * 4 + 3] = 255;
	}

	it("wraps output in the DCS introducer and string terminator", () => {
		const sixel = encodeSixel(red);
		expect(sixel.startsWith("\x1bP0;1;0q")).toBe(true);
		expect(sixel.endsWith("\x1b\\")).toBe(true);
	});

	it("declares the raster size it actually emitted", () => {
		expect(encodeSixel(red)).toContain('"1;1;6;6');
	});

	it("emits a palette entry as percentages, not 0-255", () => {
		// Pure red is 100% on the first component.
		expect(encodeSixel(red)).toContain("#0;2;100;0;0");
	});

	it("composites transparency onto the background colour", () => {
		const clear = { width: 6, height: 6, pixels: new Uint8Array(6 * 6 * 4) };
		const sixel = encodeSixel(clear, { background: [255, 255, 255] });
		expect(sixel).toContain("#0;2;100;100;100");
	});

	it("scales down to the requested bound", () => {
		const big = { width: 100, height: 100, pixels: new Uint8Array(100 * 100 * 4) };
		expect(encodeSixel(big, { maxWidth: 20 })).toContain('"1;1;20;20');
	});
});

describe("supportsSixel", () => {
	it("believes a TERM that advertises sixel", () => {
		expect(supportsSixel({ TERM: "xterm-sixel" })).toBe(true);
	});

	it("recognises iTerm2 through tmux, where TERM says nothing", () => {
		expect(supportsSixel({ TERM: "tmux-256color", TERM_PROGRAM: "iTerm.app" })).toBe(true);
	});

	it("falls back to LC_TERMINAL, which survives ssh", () => {
		expect(supportsSixel({ TERM: "tmux-256color", LC_TERMINAL: "iTerm2" })).toBe(true);
	});

	it("sees past tmux, which overwrites TERM_PROGRAM with its own name", () => {
		// The real environment inside tmux over ssh from iTerm2.
		expect(supportsSixel({ TERM: "tmux-256color", TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2" })).toBe(true);
	});

	it("does not claim sixel for tmux alone, with no known outer terminal", () => {
		expect(supportsSixel({ TERM: "tmux-256color", TERM_PROGRAM: "tmux" })).toBe(false);
	});

	it("says no for a plain terminal", () => {
		expect(supportsSixel({ TERM: "xterm-256color" })).toBe(false);
	});

	it("says no when there is no terminal at all", () => {
		expect(supportsSixel({ TERM: "dumb" })).toBe(false);
		expect(supportsSixel({})).toBe(false);
	});
});
