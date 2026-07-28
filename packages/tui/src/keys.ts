/** A decoded key press. */
export interface Key {
	/** Canonical name: "a", "enter", "up", "f1", "escape", … */
	name: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/** Raw sequence this key was decoded from. */
	sequence: string;
}

const CSI_FINAL_NAMES: Record<string, string> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	P: "f1",
	Q: "f2",
	R: "f3",
	S: "f4",
	Z: "tab",
};

const CSI_TILDE_NAMES: Record<string, string> = {
	"1": "home",
	"2": "insert",
	"3": "delete",
	"4": "end",
	"5": "pageup",
	"6": "pagedown",
	"7": "home",
	"8": "end",
	"11": "f1",
	"12": "f2",
	"13": "f3",
	"14": "f4",
	"15": "f5",
	"17": "f6",
	"18": "f7",
	"19": "f8",
	"20": "f9",
	"21": "f10",
	"23": "f11",
	"24": "f12",
};

/** Decode an xterm modifier parameter (1-based bitfield). */
function decodeModifiers(parameter: number | undefined): Pick<Key, "ctrl" | "alt" | "shift"> {
	const bits = (parameter ?? 1) - 1;
	return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

function controlCharacter(sequence: string): Key | undefined {
	const code = sequence.codePointAt(0);
	if (code === undefined) return undefined;
	if (code === 0x0d || code === 0x0a) return key("enter", sequence);
	if (code === 0x09) return key("tab", sequence);
	if (code === 0x7f || code === 0x08) return key("backspace", sequence);
	if (code === 0x1b) return key("escape", sequence);
	if (code === 0x00) return { name: "space", ctrl: true, alt: false, shift: false, sequence };
	if (code < 0x20) {
		// Ctrl+letter arrives as the letter's position in the alphabet.
		return { name: String.fromCharCode(code + 0x60), ctrl: true, alt: false, shift: false, sequence };
	}
	return undefined;
}

function key(name: string, sequence: string, modifiers?: Partial<Key>): Key {
	return { name, ctrl: false, alt: false, shift: false, sequence, ...modifiers };
}

/**
 * Parse a single key sequence read from stdin.
 *
 * Input is assumed to already be split into individual key sequences by
 * {@link splitKeySequences}; anything unrecognised is returned as a literal.
 */
export function parseKey(sequence: string): Key {
	if (sequence.length === 0) return key("", sequence);

	// CSI: ESC [ params final
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC
	const csi = /^\x1b\[([0-9;]*)([~A-Za-z])$/.exec(sequence);
	if (csi) {
		const parameters = (csi[1] ?? "").split(";");
		const final = csi[2] ?? "";
		const modifiers = decodeModifiers(Number(parameters[1]) || undefined);
		if (final === "~") {
			const name = CSI_TILDE_NAMES[parameters[0] ?? ""];
			if (name) return key(name, sequence, modifiers);
		} else {
			const name = CSI_FINAL_NAMES[final];
			// CSI Z is always shift+tab regardless of parameters.
			if (final === "Z") return key("tab", sequence, { ...modifiers, shift: true });
			if (name) return key(name, sequence, modifiers);
		}
	}

	// Kitty keyboard protocol: ESC [ unicode ; modifiers [;event] u
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC
	const kitty = /^\x1b\[(\d+)(?:;(\d+))?(?:;\d+)?u$/.exec(sequence);
	if (kitty) {
		const codePoint = Number(kitty[1]);
		const modifiers = decodeModifiers(Number(kitty[2]) || undefined);
		if (codePoint === 13) return key("enter", sequence, modifiers);
		if (codePoint === 9) return key("tab", sequence, modifiers);
		if (codePoint === 27) return key("escape", sequence, modifiers);
		if (codePoint === 127) return key("backspace", sequence, modifiers);
		return key(String.fromCodePoint(codePoint), sequence, modifiers);
	}

	// SS3: ESC O final (application cursor mode)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC
	const ss3 = /^\x1bO([A-Za-z])$/.exec(sequence);
	if (ss3) {
		const name = CSI_FINAL_NAMES[ss3[1] ?? ""];
		if (name) return key(name, sequence);
	}

	// Alt+key arrives as ESC followed by the key.
	if (sequence.length > 1 && sequence.startsWith("\x1b") && !sequence.startsWith("\x1b[")) {
		const inner = parseKey(sequence.slice(1));
		return { ...inner, alt: true, sequence };
	}

	const control = controlCharacter(sequence);
	if (control) return control;

	if (sequence === " ") return key("space", sequence);

	const characters = [...sequence];
	if (characters.length === 1) {
		const char = characters[0] ?? "";
		return key(char.toLowerCase(), sequence, { shift: char !== char.toLowerCase() });
	}
	return key(sequence, sequence);
}

/**
 * Split a raw stdin chunk into individual key sequences. Terminals coalesce
 * fast typing and pasted text into one read, so a chunk may hold many keys.
 */
export function splitKeySequences(data: string): string[] {
	const sequences: string[] = [];
	let index = 0;
	while (index < data.length) {
		const char = data[index] ?? "";
		if (char !== "\x1b") {
			// Consume a whole code point (surrogate pairs must stay together).
			const codePoint = data.codePointAt(index);
			const size = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
			sequences.push(data.slice(index, index + size));
			index += size;
			continue;
		}
		const next = data[index + 1];
		if (next === undefined) {
			sequences.push("\x1b");
			index += 1;
			continue;
		}
		if (next === "[" || next === "O") {
			// Scan to the final byte of the CSI/SS3 sequence.
			let end = index + 2;
			while (end < data.length) {
				const code = data.charCodeAt(end);
				if (code >= 0x40 && code <= 0x7e) break;
				end += 1;
			}
			sequences.push(data.slice(index, Math.min(end + 1, data.length)));
			index = end + 1;
			continue;
		}
		// ESC followed by a normal key: alt-modified.
		sequences.push(data.slice(index, index + 2));
		index += 2;
	}
	return sequences;
}

/**
 * Match a key against a binding string such as "ctrl+c", "shift+tab" or "escape".
 * Modifiers may appear in any order.
 */
export function matchesKey(input: Key, binding: string): boolean {
	const parts = binding.toLowerCase().split("+");
	const name = parts.at(-1) ?? "";
	const wantsCtrl = parts.includes("ctrl");
	const wantsAlt = parts.includes("alt") || parts.includes("meta");
	const wantsShift = parts.includes("shift");
	return input.name === name && input.ctrl === wantsCtrl && input.alt === wantsAlt && (!wantsShift || input.shift);
}

/** True when the key produces literal text rather than an editing command. */
export function isPrintable(input: Key): boolean {
	if (input.ctrl || input.alt) return false;
	if (input.name === "space") return true;
	return [...input.sequence].length === 1 && (input.sequence.codePointAt(0) ?? 0) >= 0x20;
}
