import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { HStack, VStack, type Component, type ScrollView, type TUI } from "@earendil-works/pi-tui";

export interface FullscreenShellContext {
	tui: TUI;
	theme: () => Theme;
	keybindings: KeybindingsManager;
	scroll: ScrollView;
	requestRender: () => void;
}

export interface MountedViewportSlots {
	topSlot?: Component & { dispose?(): void };
	rightRail?: Component & {
		basisWidth: number;
		isVisible: (viewport: { width: number; height: number }) => boolean;
		dispose?(): void;
	};
}

/**
 * Composes `StickyPromptBar`, `ScrollView` (`scrollbar: "auto"`), and `OutlineRail`
 * through a unified `VStack` + `HStack` layout while preserving `ScrollView`'s native scrollbar:
 *
 *   VStack:
 *     ├── StickyPromptBar (top, auto height)
 *     ├── HStack (grow: 1):
 *     │     ├── Transcript ScrollView (grow: 1, native scrollbar intact)
 *     │     └── OutlineRail (basis: 2, visible when >= 2 turns)
 *     └── Dock (pending messages, status, widgets, editor, footer)
 */
export function composeFullscreenSlots(
	originalRoot: Component,
	scroll: ScrollView,
	slots: MountedViewportSlots,
): VStack {
	const rootEntries: any[] | undefined = (originalRoot as any).entries;
	const transcriptIdx = Array.isArray(rootEntries)
		? rootEntries.findIndex((e) => e?.component === scroll)
		: -1;

	if (transcriptIdx !== -1 && Array.isArray(rootEntries)) {
		const middleRow = slots.rightRail
			? new HStack([
					{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{
						component: slots.rightRail,
						basis: slots.rightRail.basisWidth,
						grow: 0,
						shrink: 0,
						visible: slots.rightRail.isVisible,
					},
				])
			: scroll;

		const nextEntries = [
			...(slots.topSlot
				? [{ component: slots.topSlot, basis: "auto" as const, grow: 0, shrink: 0 }]
				: []),
			...rootEntries.slice(0, transcriptIdx),
			{ component: middleRow, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			...rootEntries.slice(transcriptIdx + 1),
		];
		return new VStack(nextEntries);
	}

	return new VStack([
		...(slots.topSlot
			? [{ component: slots.topSlot, basis: "auto" as const, grow: 0, shrink: 0 }]
			: []),
		{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
}
