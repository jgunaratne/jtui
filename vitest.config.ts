import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	resolve: {
		// Tests run against sources; the package `exports` fields point at dist,
		// which only exists after a build.
		alias: {
			"@jtui/tui": source("./packages/tui/src/index.ts"),
			"@jtui/ai": source("./packages/ai/src/index.ts"),
			"@jtui/agent": source("./packages/agent/src/index.ts"),
			"@jtui/cli": source("./packages/cli/src/index.ts"),
		},
	},
	test: {
		include: ["packages/*/test/**/*.test.ts"],
	},
});
