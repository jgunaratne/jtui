import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/catalog.ts";
import { latestModels, parseModelVersion } from "../src/versions.ts";

function google(id: string): CatalogEntry {
	return { id, publisher: "google", api: "gemini" };
}

function anthropic(id: string): CatalogEntry {
	return { id, publisher: "anthropic", api: "anthropic" };
}

describe("parseModelVersion", () => {
	it("reads a Gemini version from its single token", () => {
		expect(parseModelVersion("gemini-3.7-flash", "gemini")).toMatchObject({
			family: "gemini-flash",
			version: 3.7,
			preview: false,
		});
	});

	it("joins the two tokens Claude spreads a version over", () => {
		expect(parseModelVersion("claude-opus-4-8", "anthropic")).toMatchObject({ family: "claude-opus", version: 4.8 });
	});

	it("treats a bare Claude major as x.0", () => {
		expect(parseModelVersion("claude-opus-5", "anthropic").version).toBe(5);
	});

	it("keeps the variant in the family so lite is its own line", () => {
		expect(parseModelVersion("gemini-3.5-flash-lite", "gemini").family).toBe("gemini-flash-lite");
		expect(parseModelVersion("gemini-3.1-flash-lite-image", "gemini").family).toBe("gemini-flash-lite-image");
	});

	it("strips preview markers and their trailing date", () => {
		expect(parseModelVersion("gemini-2.5-flash-preview-04-17", "gemini")).toMatchObject({
			family: "gemini-flash",
			version: 2.5,
			preview: true,
		});
	});

	it("strips revision suffixes and dated snapshots", () => {
		expect(parseModelVersion("gemini-2.0-flash-001", "gemini")).toMatchObject({ family: "gemini-flash", version: 2 });
		expect(parseModelVersion("claude-opus-4-5@20251101", "anthropic")).toMatchObject({ version: 4.5 });
	});
});

describe("latestModels", () => {
	it("keeps only the newest release of a line", () => {
		const entries = [
			google("gemini-2.5-flash"),
			google("gemini-3-flash-preview"),
			google("gemini-3.5-flash"),
			google("gemini-3.6-flash"),
			google("gemini-3.7-flash"),
		];
		expect(latestModels(entries).map((entry) => entry.id)).toEqual(["gemini-3.7-flash"]);
	});

	it("treats variants as separate lines", () => {
		const entries = [google("gemini-3.7-flash"), google("gemini-3.5-flash-lite"), google("gemini-2.5-pro")];
		expect(latestModels(entries).map((entry) => entry.id)).toEqual([
			"gemini-3.7-flash",
			"gemini-3.5-flash-lite",
			"gemini-2.5-pro",
		]);
	});

	it("keeps one winner per Claude family", () => {
		const entries = [anthropic("claude-opus-4-5"), anthropic("claude-opus-4-8"), anthropic("claude-sonnet-4-6")];
		expect(latestModels(entries).map((entry) => entry.id)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
	});

	it("prefers a stable release over a preview of the same version", () => {
		const entries = [google("gemini-3.1-pro-preview"), google("gemini-3.1-pro")];
		expect(latestModels(entries).map((entry) => entry.id)).toEqual(["gemini-3.1-pro"]);
	});

	it("still prefers a newer preview over an older stable", () => {
		const entries = [google("gemini-2.5-pro"), google("gemini-3.1-pro-preview")];
		expect(latestModels(entries).map((entry) => entry.id)).toEqual(["gemini-3.1-pro-preview"]);
	});

	it("does not collapse the same family across publishers", () => {
		const entries = [google("gemini-3.7-flash"), { id: "gemini-3.7-flash", publisher: "other", api: undefined }];
		expect(latestModels(entries)).toHaveLength(2);
	});

	it("preserves input ordering", () => {
		const entries = [google("gemini-3.5-flash-lite"), google("gemini-3.7-flash"), google("gemini-2.5-pro")];
		expect(latestModels(entries).map((entry) => entry.id)).toEqual([
			"gemini-3.5-flash-lite",
			"gemini-3.7-flash",
			"gemini-2.5-pro",
		]);
	});
});
