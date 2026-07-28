import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message, Usage } from "@jtui/ai";
import { emptyUsage } from "@jtui/ai";
import type { AgentState } from "./types.ts";

interface SessionHeader {
	type: "session";
	id: string;
	cwd: string;
	model: string;
	startedAt: string;
}

interface MessageRecord {
	type: "message";
	message: Message;
}

interface UsageRecord {
	type: "usage";
	usage: Usage;
}

/**
 * Marks the point where compaction replaced the first `removed` messages with
 * `message`. The originals stay in the log — it records what happened — and a
 * resumed session replays this to arrive at the compacted history.
 */
interface CompactionRecord {
	type: "compaction";
	removed: number;
	message: Message;
}

type SessionRecord = SessionHeader | MessageRecord | UsageRecord | CompactionRecord;

/**
 * Append-only JSONL session log.
 *
 * Every message is flushed as it is produced, so an interrupted run still
 * leaves a resumable transcript on disk.
 */
export class Session {
	readonly id: string;
	readonly path: string;
	private written = 0;

	constructor(directory: string, id: string, header: Omit<SessionHeader, "type" | "id">) {
		this.id = id;
		mkdirSync(directory, { recursive: true });
		this.path = join(directory, `${id}.jsonl`);
		if (!existsSync(this.path)) {
			this.append({ type: "session", id, ...header });
		}
	}

	/** Persist any messages added to `state` since the last call. */
	sync(state: AgentState): void {
		// Compaction rewrites the head of the conversation, so the array can
		// shrink between calls. recordCompaction() realigns, but guard here too so
		// a host that forgets it logs duplicates rather than dropping everything
		// from that point on.
		if (state.messages.length < this.written) this.written = state.messages.length;
		for (const message of state.messages.slice(this.written)) {
			this.append({ type: "message", message });
		}
		this.written = state.messages.length;
		this.append({ type: "usage", usage: state.totalUsage });
	}

	private append(record: SessionRecord): void {
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}

	/** Mark messages already on disk as written, e.g. after resuming. */
	markWritten(count: number): void {
		this.written = count;
	}

	/**
	 * Note that compaction replaced the first `removed` messages of `state`, so
	 * resuming rebuilds the compacted history instead of the original.
	 */
	recordCompaction(state: AgentState, removed: number): void {
		const summary = state.messages[0];
		if (!summary) return;
		this.append({ type: "compaction", removed, message: summary });
		this.written = state.messages.length;
	}
}

/** Read a session transcript back into agent state. */
export function loadSession(path: string): AgentState {
	const state: AgentState = { messages: [], totalUsage: emptyUsage() };
	if (!existsSync(path)) return state;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const record = JSON.parse(line) as SessionRecord;
			if (record.type === "message") state.messages.push(record.message);
			if (record.type === "usage") state.totalUsage = record.usage;
			// Replay the rewrite so a resumed session starts from the summary, not
			// the history it was meant to replace.
			if (record.type === "compaction") state.messages.splice(0, record.removed, record.message);
		} catch {
			// A partial final line is expected if the process was killed mid-write.
		}
	}
	return state;
}

export interface SessionSummary {
	id: string;
	path: string;
	modifiedAt: Date;
	messageCount: number;
	firstPrompt: string;
}

/** List sessions in a directory, newest first. */
export function listSessions(directory: string): SessionSummary[] {
	if (!existsSync(directory)) return [];
	const summaries: SessionSummary[] = [];
	for (const entry of readdirSync(directory)) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(directory, entry);
		const state = loadSession(path);
		const first = state.messages.find((message) => message.role === "user");
		let text = "";
		if (first) {
			text =
				typeof first.content === "string"
					? first.content
					: first.content
							.map((block) => (block.type === "text" ? block.text : ""))
							.join(" ")
							.trim();
		}
		summaries.push({
			id: entry.replace(/\.jsonl$/, ""),
			path,
			modifiedAt: statSync(path).mtime,
			messageCount: state.messages.length,
			firstPrompt: text.split("\n")[0]?.slice(0, 80) ?? "",
		});
	}
	return summaries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/** Generate a sortable session id from the current time. */
export function newSessionId(now = new Date()): string {
	return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
