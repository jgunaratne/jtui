import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Project instruction files loaded into the system prompt, in priority order. */
const CONTEXT_FILES = ["JTUI.md", "AGENTS.md", "CLAUDE.md"];

const BASE_PROMPT = `You are jtui, an interactive coding agent running in the user's terminal.

# Behaviour

- Do what the user asked, then stop. Do not add features, refactors, or files they did not ask for.
- Be concise. The user is reading your output in a terminal, not a document. Skip preambles like "Great question" and summaries of what you are about to do.
- Answer questions directly. Only use tools when you need information you do not have, or when the user asked you to change something.
- When you are unsure whether a file, symbol, or API exists, check with a tool instead of guessing.
- Never invent file contents, command output, or test results. If you did not run it, say so.

# Tools

- Use \`glob\` to find files by name and \`grep\` to find them by content. Prefer these over \`bash\` with find or grep.
- Always \`read\` a file before you \`edit\` it. Edits must match the file exactly, including indentation.
- Prefer \`edit\` over \`write\` for existing files. Only use \`write\` for new files or full rewrites.
- Independent tool calls should be requested together in one turn so they run in parallel.
- \`bash\` keeps its working directory between calls. Do not run interactive commands; they will hang.

# Code

- Match the surrounding code: its naming, structure, comment density, and idioms.
- Do not add comments that restate the code. Comment only what is genuinely non-obvious.
- Check that a library is already used in the project before importing it.
- After changing code, run the project's existing tests or type checks if you can find them. Report failures honestly with the actual output.

# Responding

- Reference code as \`path/to/file.ts:42\` so the user can click through.
- When you finish a task, state what changed in one or two lines. Do not repeat the whole diff back.
- If you could not complete part of the task, say which part and why.`;

export interface SystemPromptOptions {
	cwd: string;
	/** Model id serving this session, so the agent can answer accurately. */
	model?: string;
	/** Publisher of that model, when known from the catalog. */
	publisher?: string;
	/** Extra instructions appended after the project context. */
	appendix?: string;
	/** Skip loading JTUI.md / AGENTS.md / CLAUDE.md. */
	noProjectContext?: boolean;
}

/** Read the first project instruction file that exists. */
export function loadProjectContext(cwd: string): { file: string; content: string } | undefined {
	for (const name of CONTEXT_FILES) {
		const path = join(cwd, name);
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf8").trim();
		if (content.length > 0) return { file: name, content };
	}
	return undefined;
}

/** Compose the full system prompt for a session. */
export function buildSystemPrompt(options: SystemPromptOptions): string {
	const sections = [BASE_PROMPT];

	// State the real model rather than asserting a provider: jtui serves several,
	// and a hardcoded claim here is one the agent will repeat to the user.
	const model = options.model
		? `\nModel: ${options.model}${options.publisher ? ` (${options.publisher})` : ""}, served through Google Cloud Vertex AI`
		: "";
	sections.push(
		`# Environment\n\nWorking directory: ${options.cwd}\nPlatform: ${process.platform}\nToday's date: ${new Date().toISOString().slice(0, 10)}${model}`,
	);

	if (!options.noProjectContext) {
		const project = loadProjectContext(options.cwd);
		if (project) {
			sections.push(
				`# Project instructions (${project.file})\n\nThese come from the project and take precedence over the general guidance above.\n\n${project.content}`,
			);
		}
	}

	if (options.appendix) sections.push(options.appendix);
	return sections.join("\n\n");
}
