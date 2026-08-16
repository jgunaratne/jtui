import { describe, expect, it } from "vitest";
import { adapterModels, type CatalogEntry, type ModelCatalog, supportedModels } from "../src/catalog.ts";
import { applyProbeResults, condenseError, type ProbeResult } from "../src/probe.ts";

function catalogOf(entries: CatalogEntry[]): ModelCatalog {
	return { project: "p", location: "global", fetchedAt: 0, entries };
}

describe("condenseError", () => {
	it("extracts the nested message from a Vertex error body", () => {
		const raw = '404 [{"error":{"code":404,"message":"Publisher model `x` was not found","status":"NOT_FOUND"}}]';
		expect(condenseError(raw)).toBe("Publisher model `x` was not found");
	});

	it("falls back to the raw text when the body is not JSON", () => {
		expect(condenseError("connection reset")).toBe("connection reset");
	});

	it("collapses whitespace and truncates very long messages", () => {
		const result = condenseError(`boom${"x".repeat(500)}`);
		expect(result.length).toBeLessThanOrEqual(160);
		expect(result.endsWith("…")).toBe(true);
	});

	it("survives a body truncated mid-JSON", () => {
		expect(condenseError('403 [{"error":{"code":403,"message":"Access to this mod')).toContain("403");
	});

	it("unwraps the second JSON document Gemini nests inside error.message", () => {
		const inner = JSON.stringify({
			error: { code: 400, message: "Thinking level is unsupported", status: "INVALID_ARGUMENT" },
		});
		const raw = JSON.stringify({ error: { message: inner } });
		expect(condenseError(raw)).toBe("Thinking level is unsupported");
	});

	it("handles an object-rooted body as well as an array-rooted one", () => {
		expect(condenseError('{"error":{"code":404,"message":"not found"}}')).toBe("not found");
	});

	it("ignores the advice formatVertexError appends after the body", () => {
		const raw =
			'404 [{"error":{"code":404,"message":"Publisher model `x` was not found"}}]\n\nProject "p" cannot call it.';
		expect(condenseError(raw)).toBe("Publisher model `x` was not found");
	});

	it("is not confused by braces inside the message text", () => {
		const raw = '400 [{"error":{"message":"bad {token} here"}}]\n\nadvice';
		expect(condenseError(raw)).toBe("bad {token} here");
	});
});

describe("applyProbeResults", () => {
	const entries: CatalogEntry[] = [
		{ id: "gemini-3.7-flash", publisher: "google", api: "gemini" },
		{ id: "claude-haiku-4-5", publisher: "anthropic", api: "anthropic" },
		{ id: "codestral-2", publisher: "mistralai", api: undefined },
	];

	const results: ProbeResult[] = [
		{ id: "gemini-3.7-flash", available: true },
		{ id: "claude-haiku-4-5", available: false, reason: "not found" },
	];

	it("records availability and the failure reason", () => {
		const updated = applyProbeResults(entries, results, 123);
		expect(updated[0]).toMatchObject({ available: true, checkedAt: 123 });
		expect(updated[0]?.unavailableReason).toBeUndefined();
		expect(updated[1]).toMatchObject({ available: false, unavailableReason: "not found", checkedAt: 123 });
	});

	it("leaves entries with no result untouched", () => {
		expect(applyProbeResults(entries, results, 123)[2]).toEqual(entries[2]);
	});

	it("clears a stale reason when a model starts working", () => {
		const stale: CatalogEntry[] = [
			{
				id: "gemini-3.7-flash",
				publisher: "google",
				api: "gemini",
				available: false,
				unavailableReason: "old",
				checkedAt: 1,
			},
		];
		const updated = applyProbeResults(stale, [{ id: "gemini-3.7-flash", available: true }], 2);
		expect(updated[0]?.available).toBe(true);
		expect(updated[0]?.unavailableReason).toBeUndefined();
	});
});

describe("supportedModels", () => {
	it("hides models a check proved uncallable", () => {
		const catalog = catalogOf(
			applyProbeResults(
				[
					{ id: "gemini-3.7-flash", publisher: "google", api: "gemini" },
					{ id: "claude-haiku-4-5", publisher: "anthropic", api: "anthropic" },
				],
				[
					{ id: "gemini-3.7-flash", available: true },
					{ id: "claude-haiku-4-5", available: false, reason: "not found" },
				],
			),
		);
		expect(supportedModels(catalog).map((entry) => entry.id)).toEqual(["gemini-3.7-flash"]);
		expect(adapterModels(catalog)).toHaveLength(2);
	});

	it("keeps unchecked models, since listing is not proof either way", () => {
		const catalog = catalogOf([{ id: "gemini-3.7-flash", publisher: "google", api: "gemini" }]);
		expect(supportedModels(catalog)).toHaveLength(1);
	});

	it("still drops publishers with no adapter", () => {
		const catalog = catalogOf([{ id: "codestral-2", publisher: "mistralai", api: undefined }]);
		expect(supportedModels(catalog)).toHaveLength(0);
	});
});
