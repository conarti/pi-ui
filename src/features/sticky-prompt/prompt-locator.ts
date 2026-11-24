import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";

export interface LocatedPrompt {
	component: UserMessageComponent;
	text: string;
	index: number;
	start: number;
	end: number;
}

export type StickyDisplayMode = "auto" | "always";

export function sanitizePromptText(text: string): string {
	const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
	return stripTerminalSequences(text.replace(/\r\n?/g, "\n")).replace(controls, "");
}

export function formatShort24hTime(timestamp: number | string | undefined): string {
	if (timestamp === undefined) return "";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function collectTranscriptPrompts(doc: Component, width: number): LocatedPrompt[] {
	const users: UserMessageComponent[] = [];
	const visit = (component: Component): void => {
		if (component instanceof UserMessageComponent) users.push(component);
		else if (component instanceof Container) component.children.forEach(visit);
	};
	visit(doc);

	const lines = doc.render(width);
	const prompts: LocatedPrompt[] = [];
	let cursor = 0;

	for (const component of users) {
		const block = component.render(width);
		if (block.length === 0) continue;
		while (cursor < lines.length && !block.every((line, offset) => lines[cursor + offset] === line)) {
			cursor++;
		}
		if (cursor >= lines.length) break;
		const text: unknown = Reflect.get(component, "text");
		prompts.push({
			component,
			text: typeof text === "string" ? text : "",
			index: prompts.length,
			start: cursor,
			end: cursor + block.length,
		});
		cursor += block.length;
	}
	return prompts;
}

export function selectStickyPrompt(
	prompts: readonly LocatedPrompt[],
	scrollTop: number,
	followingEnd: boolean,
	mode: StickyDisplayMode,
): LocatedPrompt | undefined {
	if (prompts.length === 0) return undefined;
	if (followingEnd) {
		return mode === "always" ? prompts.at(-1) : scrollTop >= (prompts.at(-1)?.end ?? 0) - 1 ? prompts.at(-1) : undefined;
	}
	const prompt = prompts.findLast((item) => item.start <= scrollTop);
	if (!prompt) return mode === "always" ? prompts[0] : undefined;
	return mode === "always" || scrollTop >= prompt.end - 1 ? prompt : undefined;
}
