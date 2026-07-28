export interface LoopDetectorOptions {
	/** Consecutive repeats of a unit before the output is judged stuck. */
	threshold?: number;
	/** Longest repeating unit considered, in lines. */
	maxPeriod?: number;
	/** Minimum non-whitespace characters in a unit before it counts. */
	minUnitLength?: number;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_MAX_PERIOD = 4;
/**
 * Low enough to catch a short looping sentence, high enough that structural
 * repeats cannot reach it: `| --- | --- |` is 9 non-space characters, a code
 * fence is 3, and `- item` is 5.
 */
const DEFAULT_MIN_UNIT_LENGTH = 16;

/**
 * Spots a model that has started repeating itself.
 *
 * Text is fed in as it streams and split into lines; after each completed line
 * the tail is checked for a unit of 1..maxPeriod lines repeated `threshold`
 * times in a row. That catches both a single sentence looping and a short
 * multi-line cycle.
 *
 * Deliberately conservative: a unit must carry real text, so numbered lists,
 * blank lines, table rules and code-fence markers cannot trip it.
 */
export class LoopDetector {
	private readonly threshold: number;
	private readonly maxPeriod: number;
	private readonly minUnitLength: number;
	private lines: string[] = [];
	private partial = "";
	private detected: string | undefined;

	constructor(options: LoopDetectorOptions = {}) {
		this.threshold = Math.max(2, options.threshold ?? DEFAULT_THRESHOLD);
		this.maxPeriod = Math.max(1, options.maxPeriod ?? DEFAULT_MAX_PERIOD);
		this.minUnitLength = options.minUnitLength ?? DEFAULT_MIN_UNIT_LENGTH;
	}

	/** The repeated text, once a loop has been found. */
	get repeatedUnit(): string | undefined {
		return this.detected;
	}

	/** Feed streamed text. Returns true once a loop is detected. */
	push(delta: string): boolean {
		if (this.detected) return true;
		this.partial += delta;

		let newline = this.partial.indexOf("\n");
		while (newline !== -1) {
			this.lines.push(this.partial.slice(0, newline).trimEnd());
			this.partial = this.partial.slice(newline + 1);
			// Keep only what the widest check can look at.
			const keep = this.maxPeriod * this.threshold;
			if (this.lines.length > keep) this.lines = this.lines.slice(-keep);
			if (this.check()) return true;
			newline = this.partial.indexOf("\n");
		}
		return false;
	}

	reset(): void {
		this.lines = [];
		this.partial = "";
		this.detected = undefined;
	}

	/** Look for a repeating unit at the tail of the completed lines. */
	private check(): boolean {
		for (let period = 1; period <= this.maxPeriod; period++) {
			const needed = period * this.threshold;
			if (this.lines.length < needed) continue;

			const tail = this.lines.slice(-needed);
			const unit = tail.slice(0, period);
			// Measure distinct content: a short line repeated within the unit
			// would otherwise clear the floor purely by being counted twice,
			// letting `| --- |` trip at period 2 what it cannot trip at period 1.
			const distinct = [...new Set(unit)].join("");
			if (distinct.replace(/\s/g, "").length < this.minUnitLength) continue;

			let repeats = true;
			for (let block = 1; block < this.threshold && repeats; block++) {
				for (let offset = 0; offset < period; offset++) {
					if (tail[block * period + offset] !== unit[offset]) {
						repeats = false;
						break;
					}
				}
			}
			if (repeats) {
				this.detected = unit.join("\n");
				return true;
			}
		}
		return false;
	}
}
