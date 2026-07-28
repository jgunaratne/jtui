import { describe, expect, it } from "vitest";
import { LoopDetector } from "../src/loop-detector.ts";

/** Feed text one chunk at a time, reporting whether a loop was found. */
function feed(detector: LoopDetector, text: string, chunk = 7): boolean {
	let tripped = false;
	for (let index = 0; index < text.length; index += chunk) {
		if (detector.push(text.slice(index, index + chunk))) tripped = true;
	}
	return tripped;
}

const SENTENCE = "I don't have that detail exposed to me, only the provider.";

describe("LoopDetector", () => {
	it("catches a single sentence repeating", () => {
		const detector = new LoopDetector();
		expect(feed(detector, `${SENTENCE}\n`.repeat(6))).toBe(true);
		expect(detector.repeatedUnit).toBe(SENTENCE);
	});

	it("does not trip below the threshold", () => {
		const detector = new LoopDetector({ threshold: 5 });
		expect(feed(detector, `${SENTENCE}\n`.repeat(4))).toBe(false);
	});

	it("catches a multi-line cycle", () => {
		const detector = new LoopDetector();
		const cycle = "Checking the configuration file now.\nThat did not work, retrying.\n";
		expect(feed(detector, cycle.repeat(6))).toBe(true);
	});

	it("leaves ordinary prose alone", () => {
		const detector = new LoopDetector();
		const prose = [
			"Bubble sort repeatedly swaps adjacent elements that are out of order.",
			"Selection sort moves the smallest remaining element to the front.",
			"Insertion sort builds the result one element at a time.",
			"Merge sort splits the list, sorts each half, and merges them.",
			"Quick sort partitions around a pivot and recurses on both sides.",
			"Heap sort repeatedly extracts the maximum from a binary heap.",
			"Radix sort processes digits from least to most significant.",
			"Counting sort tallies how often each distinct key occurs.",
		].join("\n");
		expect(feed(detector, `${prose}\n`)).toBe(false);
	});

	it("ignores repeated blank lines", () => {
		const detector = new LoopDetector();
		expect(feed(detector, "\n".repeat(40))).toBe(false);
	});

	it("ignores repeated structural punctuation", () => {
		const detector = new LoopDetector();
		// Table rules and code fences legitimately repeat.
		expect(feed(detector, "| --- | --- |\n".repeat(10))).toBe(false);
		expect(feed(detector, "```\n".repeat(10))).toBe(false);
	});

	it("does not trip on a repeated short list marker", () => {
		const detector = new LoopDetector();
		expect(feed(detector, "- item\n".repeat(12))).toBe(false);
	});

	it("detects regardless of how deltas are chunked", () => {
		for (const chunk of [1, 3, 50, 5000]) {
			const detector = new LoopDetector();
			expect(feed(detector, `${SENTENCE}\n`.repeat(6), chunk), `chunk=${chunk}`).toBe(true);
		}
	});

	it("stays tripped once detected", () => {
		const detector = new LoopDetector();
		feed(detector, `${SENTENCE}\n`.repeat(6));
		expect(detector.push("something else entirely\n")).toBe(true);
	});

	it("clears on reset", () => {
		const detector = new LoopDetector();
		feed(detector, `${SENTENCE}\n`.repeat(6));
		detector.reset();
		expect(detector.repeatedUnit).toBeUndefined();
		expect(detector.push("a fresh line\n")).toBe(false);
	});

	it("catches a short looping sentence", () => {
		const detector = new LoopDetector();
		// 20 non-space characters: below the old floor, still plainly a loop.
		expect(feed(detector, "stuck in a loop here now.\n".repeat(8))).toBe(true);
	});

	it("still ignores repeated code lines shorter than the floor", () => {
		const detector = new LoopDetector();
		expect(feed(detector, "  return null;\n".repeat(10))).toBe(false);
	});

	it("honours a custom threshold", () => {
		const detector = new LoopDetector({ threshold: 3 });
		expect(feed(detector, `${SENTENCE}\n`.repeat(3))).toBe(true);
	});
});
