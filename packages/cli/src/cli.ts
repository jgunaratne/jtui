#!/usr/bin/env node
import { main } from "./main.ts";

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`jtui: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
