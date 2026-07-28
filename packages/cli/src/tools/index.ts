import type { AgentTool } from "@jtui/agent";
import { BashExecutor, createBashTool } from "./bash-tool.ts";
import { editTool, listTool, readTool, writeTool } from "./file-tools.ts";
import { globTool, grepTool } from "./search-tools.ts";

export { BashExecutor, createBashTool } from "./bash-tool.ts";
export { MAX_TOOL_OUTPUT, truncateOutput } from "./common.ts";
export { editTool, listTool, readTool, writeTool } from "./file-tools.ts";
export { globTool, grepTool } from "./search-tools.ts";

/** The default tool set, bound to a shell whose cwd persists across calls. */
export function createDefaultTools(cwd: string): { tools: AgentTool<never>[]; bash: BashExecutor } {
	const bash = new BashExecutor(cwd);
	const tools = [readTool, writeTool, editTool, listTool, globTool, grepTool, createBashTool(bash)];
	return { tools: tools as unknown as AgentTool<never>[], bash };
}
