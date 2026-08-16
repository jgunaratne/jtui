import { describe, expect, it } from "vitest";
import { parseQuotaReset } from "../src/modes/interactive.ts";

describe("parseQuotaReset", () => {
	it("extracts a compound duration from the antigravity quota message", () => {
		const message = "You have exhausted your capacity on this model. Your quota will reset after 10m10s.";
		expect(parseQuotaReset(message)).toBe((10 * 60 + 10) * 1000);
	});

	it("handles hours, minutes, and seconds", () => {
		expect(parseQuotaReset("quota will reset after 1h2m3s")).toBe((3600 + 120 + 3) * 1000);
	});

	it("handles a seconds-only window", () => {
		expect(parseQuotaReset("Your quota will reset in 30s")).toBe(30_000);
	});

	it("returns undefined for unrelated errors", () => {
		expect(parseQuotaReset("Request failed with status 500")).toBeUndefined();
	});

	it("returns undefined when no duration is present", () => {
		expect(parseQuotaReset("You have exhausted your capacity on this model.")).toBeUndefined();
	});
});
