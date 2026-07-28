import type { Key } from "../keys.ts";
import { matchesKey } from "../keys.ts";
import { bold, cyan, dim } from "../styles.ts";
import type { Focusable } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

export interface SelectItem<T = unknown> {
	label: string;
	/** Secondary text shown after the label. */
	description?: string;
	value: T;
}

export interface SelectListOptions<T> {
	title?: string;
	items: SelectItem<T>[];
	/** Maximum rows of items shown at once. */
	maxVisible?: number;
	onSelect?: (item: SelectItem<T>) => void;
	onCancel?: () => void;
}

/** Scrollable single-choice list driven by the arrow keys. */
export class SelectList<T = unknown> implements Focusable {
	focused = true;
	items: SelectItem<T>[];
	private selected = 0;
	private scrollOffset = 0;
	private readonly options: SelectListOptions<T>;

	constructor(options: SelectListOptions<T>) {
		this.options = options;
		this.items = options.items;
	}

	setItems(items: SelectItem<T>[]): void {
		this.items = items;
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
		this.scrollOffset = 0;
	}

	get selectedItem(): SelectItem<T> | undefined {
		return this.items[this.selected];
	}

	render(width: number): string[] {
		const maxVisible = this.options.maxVisible ?? 10;
		const out: string[] = [];
		if (this.options.title) out.push(bold(this.options.title));
		if (this.items.length === 0) {
			out.push(dim("  (no matches)"));
			return out;
		}

		// Keep the selection inside the visible window.
		if (this.selected < this.scrollOffset) this.scrollOffset = this.selected;
		if (this.selected >= this.scrollOffset + maxVisible) this.scrollOffset = this.selected - maxVisible + 1;

		const end = Math.min(this.items.length, this.scrollOffset + maxVisible);
		for (let index = this.scrollOffset; index < end; index++) {
			const item = this.items[index];
			if (!item) continue;
			const active = index === this.selected;
			const marker = active ? cyan("❯ ") : "  ";
			const label = active ? cyan(bold(item.label)) : item.label;
			const description = item.description ? dim(`  ${item.description}`) : "";
			out.push(truncateToWidth(marker + label + description, width));
		}
		if (this.items.length > maxVisible) {
			out.push(dim(`  ${this.selected + 1}/${this.items.length}`));
		}
		return out;
	}

	handleInput(key: Key): void {
		if (matchesKey(key, "up") || matchesKey(key, "ctrl+p")) {
			this.selected = this.selected === 0 ? this.items.length - 1 : this.selected - 1;
			return;
		}
		if (matchesKey(key, "down") || matchesKey(key, "ctrl+n")) {
			this.selected = this.selected === this.items.length - 1 ? 0 : this.selected + 1;
			return;
		}
		if (matchesKey(key, "enter")) {
			const item = this.selectedItem;
			if (item) this.options.onSelect?.(item);
			return;
		}
		if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
			this.options.onCancel?.();
		}
	}
}
