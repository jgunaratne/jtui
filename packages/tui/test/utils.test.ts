import { describe, expect, it } from "vitest";
import { padToWidth, sliceByColumn, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("stripAnsi", () => {
	it("removes SGR and cursor sequences", () => {
		expect(stripAnsi(`${RED}hi${RESET}`)).toBe("hi");
		expect(stripAnsi("a\x1b[2Kb")).toBe("ab");
		expect(stripAnsi("a\x1b_marker\x07b")).toBe("ab");
	});
});

describe("visibleWidth", () => {
	it("ignores escape sequences", () => {
		expect(visibleWidth(`${RED}hello${RESET}`)).toBe(5);
	});

	it("counts wide characters as two cells", () => {
		expect(visibleWidth("日本語")).toBe(6);
		expect(visibleWidth("a日b")).toBe(4);
	});

	it("treats combining marks as zero width", () => {
		expect(visibleWidth("é")).toBe(1);
	});
});

describe("wrapTextWithAnsi", () => {
	it("breaks on word boundaries", () => {
		expect(wrapTextWithAnsi("the quick brown fox", 10)).toEqual(["the quick ", "brown fox"]);
	});

	it("keeps hard newlines", () => {
		expect(wrapTextWithAnsi("a\nb", 10)).toEqual(["a", "b"]);
	});

	it("splits words longer than the width", () => {
		expect(wrapTextWithAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
	});

	it("carries styles onto continuation lines", () => {
		const wrapped = wrapTextWithAnsi(`${RED}aaa bbb${RESET}`, 4);
		expect(wrapped).toHaveLength(2);
		expect(wrapped[0]).toContain(RED);
		expect(wrapped[1]).toContain(RED);
		expect(wrapped.map(stripAnsi)).toEqual(["aaa ", "bbb"]);
	});

	it("never exceeds the requested width", () => {
		for (const line of wrapTextWithAnsi("alpha beta gamma delta epsilon", 7)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(7);
		}
	});
});

describe("truncateToWidth", () => {
	it("leaves short text untouched", () => {
		expect(truncateToWidth("abc", 10)).toBe("abc");
	});

	it("cuts to the requested width including the ellipsis", () => {
		expect(truncateToWidth("abcdef", 4)).toBe("abc…");
		expect(visibleWidth(truncateToWidth("abcdef", 4))).toBe(4);
	});

	it("closes styles it opened", () => {
		expect(truncateToWidth(`${RED}abcdef${RESET}`, 4)).toBe(`${RED}abc…${RESET}`);
	});
});

describe("sliceByColumn", () => {
	it("slices by display column", () => {
		expect(sliceByColumn("abcdef", 2, 4)).toBe("cd");
	});

	it("preserves style across the slice", () => {
		expect(stripAnsi(sliceByColumn(`${RED}abcdef${RESET}`, 1, 3))).toBe("bc");
	});
});

describe("padToWidth", () => {
	it("pads to the target width", () => {
		expect(padToWidth("ab", 5)).toBe("ab   ");
		expect(padToWidth(`${RED}ab${RESET}`, 5)).toBe(`${RED}ab${RESET}   `);
	});

	it("does not truncate longer text", () => {
		expect(padToWidth("abcdef", 3)).toBe("abcdef");
	});
});
