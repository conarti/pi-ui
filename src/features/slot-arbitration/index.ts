import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, renderPill, type HitBox } from "../../shared/ansi.ts";
import { t } from "../../shared/i18n.ts";
import {
	createModalCard,
	getThemeSurfacePalette,
	openModalCard,
	type ModalActionPill,
} from "../../shared/modal-card.ts";
import { loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import {
	applySlotOwners,
	clearAllSlotOwners,
	getContendedSlots,
	installSlotArbitration,
	markPiUiCommandHandler,
	PI_UI_OWNER_ID,
	registerSlotArbitrationModalOpener,
	type ContendedSlotSnapshot,
	type SlotArbitrationPromptMode,
} from "../../shared/slot-arbitration.ts";

type ModalOutcome =
	| { readonly kind: "apply"; readonly owners: Record<string, string> }
	| { readonly kind: "default-all" }
	| { readonly kind: "reset-saved" };

interface CandidateHit extends HitBox {
	readonly slotIndex: number;
	readonly slotId: string;
	readonly ownerId: string;
}

function formatSlotLabel(slot: ContendedSlotSnapshot): string {
	switch (slot.kind) {
		case "footer":
			return `${t("slots.kind.footer")} (footer)`;
		case "header":
			return `${t("slots.kind.header")} (header)`;
		case "editor":
			return `${t("slots.kind.editor")} (editor)`;
		case "workingIndicator":
			return `${t("slots.kind.workingIndicator")} (workingIndicator)`;
		case "command":
			return `${t("slots.kind.command")} ${slot.target ?? slot.slotId}`;
		case "shortcut":
			return `${t("slots.kind.shortcut")} ${slot.target ?? slot.slotId}`;
		case "messageRenderer":
			return `${t("slots.kind.messageRenderer")} ${slot.target ?? slot.slotId}`;
		case "entryRenderer":
			return `${t("slots.kind.entryRenderer")} ${slot.target ?? slot.slotId}`;
		case "toolRenderer":
			return `${t("slots.kind.toolRenderer")} ${slot.target ?? slot.slotId}`;
	}
}

export async function showSlotArbitrationModal(
	ctx: ExtensionContext,
	explicitSlots?: readonly ContendedSlotSnapshot[],
	mode: SlotArbitrationPromptMode = "manage",
	onShown?: () => void,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	const slots = explicitSlots ? [...explicitSlots] : getContendedSlots();
	const savedEntries = Object.entries(loadPiUiUserConfig().slotOwners);

	const selectedOwners = new Map<string, string>();
	for (const slot of slots) {
		selectedOwners.set(slot.slotId, slot.activeOwnerId);
	}

	const outcome = await openModalCard<ModalOutcome>(
		ctx,
		(tui, theme, _kb, done) => {
			onShown?.();
			const card = createModalCard();
			let focusedIndex = 0;
			let scrollOffset = 0;
			let hoveredCandidateKey: string | null = null;
			let candidateHits: CandidateHit[] = [];
			const candidateHoverOwner = {};

			const cycleOwner = (slotIdx: number, delta: number): void => {
				const slot = slots[slotIdx];
				if (!slot || slot.candidates.length < 2) return;
				const current = selectedOwners.get(slot.slotId) ?? slot.activeOwnerId;
				const curIdx = Math.max(
					0,
					slot.candidates.findIndex((c) => c.ownerId === current),
				);
				const nextIdx =
					(curIdx + delta + slot.candidates.length) % slot.candidates.length;
				selectedOwners.set(slot.slotId, slot.candidates[nextIdx]!.ownerId);
			};

			const comp: Component & {
				handleInput(data: string): void;
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
			} = {
				invalidate() {},
				render(width: number): string[] {
					const palette = getThemeSurfacePalette(theme);
					const innerWidth = Math.max(24, width - 4);
					const bodyLines: string[] = [];
					candidateHits = [];

					if (slots.length === 0) {
						bodyLines.push(theme.fg("muted", t("slots.modal.empty")));
						if (savedEntries.length > 0) {
							bodyLines.push("");
							const summary = savedEntries
								.map(([slot, owner]) => `${slot}=${owner}`)
								.join(", ");
							bodyLines.push(
								theme.fg("dim", t("slots.modal.savedSummary", { entries: summary })),
							);
						}
					} else {
						const intro =
							mode === "startup"
								? t("slots.modal.introNew")
								: t("slots.modal.introManage");
						bodyLines.push(theme.fg("muted", truncateToWidth(intro, innerWidth, "…")));
						bodyLines.push("");

						const termRows = tui.terminal?.rows ?? 28;
						const maxVisibleSlots = Math.max(
							2,
							Math.min(slots.length, Math.floor((termRows - 12) / 2)),
						);
						if (focusedIndex < scrollOffset) {
							scrollOffset = focusedIndex;
						} else if (focusedIndex >= scrollOffset + maxVisibleSlots) {
							scrollOffset = focusedIndex - maxVisibleSlots + 1;
						}
						scrollOffset = Math.max(
							0,
							Math.min(scrollOffset, Math.max(0, slots.length - maxVisibleSlots)),
						);

						const visibleEnd = Math.min(slots.length, scrollOffset + maxVisibleSlots);
						for (let idx = scrollOffset; idx < visibleEnd; idx += 1) {
							const slot = slots[idx]!;
							const isFocused = idx === focusedIndex;
							const chosenOwner =
								selectedOwners.get(slot.slotId) ?? slot.activeOwnerId;
							const prefix = isFocused
								? fgRgb(palette.accentBright, "▸ ")
								: "  ";
							const label = formatSlotLabel(slot);
							const labelStyled = isFocused
								? theme.bold(theme.fg("text", label))
								: theme.fg("text", label);

							bodyLines.push(`${prefix}${labelStyled}`);

							/* Вторая строка элемента — кликабельные пилюли кандидатов-владельцев */
							const rowY = 1 + bodyLines.length;
							const indent = "    ";
							let curX = 2 + visibleWidth(indent);
							let pillRow = indent;
							let firstPill = true;

							for (const candidate of slot.candidates) {
								const isSelected = candidate.ownerId === chosenOwner;
								const hoverKey = `${slot.slotId}:${candidate.ownerId}`;
								const isHovered = hoveredCandidateKey === hoverKey;
								const glyph = isSelected ? "●" : "○";
								const rendered = renderPill(`${glyph} ${candidate.label}`, {
									active: isSelected,
									hovered: isHovered,
									variant: isSelected ? "primary" : "neutral",
									theme,
								});
								const pillW = visibleWidth(rendered);
								const gap = firstPill ? "" : "  ";
								const gapW = firstPill ? 0 : 2;

								candidateHits.push({
									id: hoverKey,
									slotIndex: idx,
									slotId: slot.slotId,
									ownerId: candidate.ownerId,
									xStart: curX + gapW,
									xEnd: curX + gapW + pillW,
									y: rowY,
									onClick: () => {
										focusedIndex = idx;
										selectedOwners.set(slot.slotId, candidate.ownerId);
									},
								});

								pillRow += `${gap}${rendered}`;
								curX += gapW + pillW;
								firstPill = false;
							}

							bodyLines.push(pillRow);
						}

						bodyLines.push("");
						bodyLines.push(theme.fg("dim", t("slots.modal.navHint")));
					}

					const footerPills: ModalActionPill[] =
						slots.length > 0
							? [
									{
										id: "apply",
										label: t("slots.modal.apply"),
										variant: "primary",
										onClick: () =>
											done({
												kind: "apply",
												owners: Object.fromEntries(selectedOwners),
											}),
									},
									{
										id: "default-all",
										label: t("slots.modal.useDefault"),
										variant: "neutral",
										onClick: () => done({ kind: "default-all" }),
									},
									{
										id: "cancel",
										label: t("slots.modal.cancel"),
										variant: "neutral",
										onClick: () => done(undefined),
									},
								]
							: [
									...(savedEntries.length > 0
										? [
												{
													id: "reset-saved",
													label: t("slots.modal.resetSaved"),
													variant: "neutral" as const,
													onClick: () => done({ kind: "reset-saved" }),
												},
											]
										: []),
									{
										id: "close",
										label: t("slots.modal.close"),
										variant: "primary",
										onClick: () => done(undefined),
									},
								];

					const countMeta =
						slots.length === 1
							? t("slots.modal.countSingular")
							: t("slots.modal.countPlural", { count: slots.length });

					return card.render(width, theme, {
						title: theme.bold(theme.fg("text", t("slots.modal.title"))),
						headerMeta: slots.length > 0 ? theme.fg("dim", countMeta) : undefined,
						closable: true,
						onClose: () => done(undefined),
						bodyLines,
						footerPills,
					});
				},
				handleInput(data: string): void {
					if (isKeyRelease(data)) return;
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(undefined);
						return;
					}
					if (slots.length === 0) {
						if (matchesKey(data, "return") || matchesKey(data, "enter")) {
							done(undefined);
						}
						return;
					}
					if (matchesKey(data, "up")) {
						focusedIndex = (focusedIndex - 1 + slots.length) % slots.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down")) {
						focusedIndex = (focusedIndex + 1) % slots.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "right") || matchesKey(data, "tab") || data === " ") {
						cycleOwner(focusedIndex, 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
						cycleOwner(focusedIndex, -1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "return") || matchesKey(data, "enter")) {
						done({
							kind: "apply",
							owners: Object.fromEntries(selectedOwners),
						});
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type === "wheel" && event.wheelDelta && slots.length > 0) {
						const delta = event.wheelDelta < 0 ? -1 : 1;
						focusedIndex = Math.max(
							0,
							Math.min(slots.length - 1, focusedIndex + delta),
						);
						return { handled: true, render: true };
					}

					const cardOutcome = card.handleMouse(event);
					if (cardOutcome.triggered) {
						return { handled: true, render: true };
					}

					const matchedHit = candidateHits.find(
						(h) => event.y === h.y && event.x >= h.xStart && event.x < h.xEnd,
					);

					if (event.type === "move") {
						const nextHover = cardOutcome.handled ? null : (matchedHit?.id ?? null);
						if (nextHover !== null) {
							claimHover(candidateHoverOwner, () => {
								hoveredCandidateKey = null;
							});
						}
						const changed = nextHover !== hoveredCandidateKey;
						hoveredCandidateKey = nextHover;
						return { handled: true, render: cardOutcome.render || changed };
					}

					if (event.type === "press" && event.button === "left") {
						return { handled: true, render: false };
					}

					if (event.type === "click" && event.button === "left" && matchedHit) {
						matchedHit.onClick();
						return { handled: true, render: true };
					}

					return { handled: true, render: cardOutcome.render };
				},
			};

			return comp;
		},
		{ width: 82, minWidth: 50, anchor: "center", margin: 2 },
	);

	/* Применяем изменения строго после закрытия модалки, чтобы фокус корректно перешёл на новый Editor при его смене */
	if (!outcome) return;
	if (outcome.kind === "apply") {
		applySlotOwners(outcome.owners);
		ctx.ui.notify(
			t("slots.modal.applied", { count: Object.keys(outcome.owners).length }),
			"info",
		);
		return;
	}
	if (outcome.kind === "default-all") {
		const defaults: Record<string, string> = {};
		for (const slot of slots) {
			defaults[slot.slotId] = PI_UI_OWNER_ID;
		}
		applySlotOwners(defaults);
		ctx.ui.notify(t("slots.modal.applied", { count: slots.length }), "info");
		return;
	}
	if (outcome.kind === "reset-saved") {
		clearAllSlotOwners();
		ctx.ui.notify(t("slots.cleared"), "info");
	}
}

export function registerSlotArbitrationFeature(pi: ExtensionAPI): void {
	installSlotArbitration(pi);

	registerSlotArbitrationModalOpener(async (ctx, slots, mode, onShown) => {
		await showSlotArbitrationModal(ctx, slots, mode, onShown);
	});

	const slotsHandler = markPiUiCommandHandler(async (args: string, ctx: ExtensionContext) => {
		const trimmed = args.trim();
		const parts = trimmed ? trimmed.split(/\s+/) : [];
		const sub = parts[0]?.toLowerCase() ?? "";

		if (sub === "") {
			if (ctx.mode === "tui" && ctx.hasUI) {
				await showSlotArbitrationModal(ctx, undefined, "manage");
				return;
			}
			const owners = loadPiUiUserConfig().slotOwners;
			const pairs = Object.entries(owners);
			ctx.ui.notify(
				pairs.length === 0
					? t("slots.empty")
					: t("slots.status", {
							entries: pairs.map(([slot, owner]) => `${slot}=${owner}`).join(", "),
						}),
				"info",
			);
			return;
		}

		if (sub === "status") {
			const owners = loadPiUiUserConfig().slotOwners;
			const pairs = Object.entries(owners);
			if (pairs.length === 0) {
				ctx.ui.notify(t("slots.empty"), "info");
			} else {
				ctx.ui.notify(
					t("slots.status", {
						entries: pairs.map(([slot, owner]) => `${slot}=${owner}`).join(", "),
					}),
					"info",
				);
			}
			return;
		}

		if (sub === "clear" || sub === "reset") {
			clearAllSlotOwners();
			ctx.ui.notify(t("slots.cleared"), "info");
			return;
		}

		if (parts.length === 2) {
			const [slot, owner] = parts as [string, string];
			applySlotOwners({ [slot]: owner });
			ctx.ui.notify(t("slots.updated", { slot, owner }), "info");
			return;
		}

		ctx.ui.notify(t("slots.usage"), "warning");
	});

	pi.registerCommand("slots", {
		description: t("slots.command"),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const contendedIds = getContendedSlots().map((s) => s.slotId);
			const choices = ["status", "clear", ...contendedIds];
			const items = choices
				.filter((choice) => choice.toLowerCase().startsWith(typed) && choice !== typed.trimEnd())
				.map((choice) => ({ value: choice, label: choice }));
			return items.length > 0 ? items : null;
		},
		handler: slotsHandler,
	});
}
