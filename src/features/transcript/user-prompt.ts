import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, getActiveGlobalTheme, isLightTheme, paintSurfaceRow } from "../../shared/ansi.ts";
import { claimHover, copyToClipboard, hookMethod } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export function installUserPromptCards(): void {
	const proto = UserMessageComponent.prototype as any;

	hookMethod(
		proto,
		"render",
		"transcript.userPromptRender",
		(self, args) => {
			const width = args[0] as number;
			const rawText = String(self.text ?? "").trim();
			if (!rawText || width < 16) return [];

			const theme = getActiveGlobalTheme(self?.theme);
			const light = isLightTheme(theme);
			const outerPad = width >= 48 ? 2 : 0;
			const cardWidth = Math.max(10, width - outerPad * 2);
			const textAvail = Math.max(6, cardWidth - 6);

			const isHovered = Boolean(self.__conartiHovered);
			const isCopied = Boolean(self.__conartiCopied);

			const cardRgb: [number, number, number] = light
				? isHovered
					? [226, 237, 252]
					: [237, 243, 252]
				: isHovered
					? [50, 59, 75]
					: [44, 51, 64];

			const spineRgb = light
				? isHovered
					? [29, 78, 216]
					: [37, 99, 235]
				: isHovered
					? [125, 207, 255]
					: [97, 175, 239];

			const spine = fgRgb(spineRgb[0]!, spineRgb[1]!, spineRgb[2]!, "┃");
			const chevron = fgRgb(spineRgb[0]!, spineRgb[1]!, spineRgb[2]!, "› ");
			const styleBody = (s: string) => (light ? fgRgb(30, 41, 59, s) : fgRgb(220, 229, 242, s));

			const wrappedRows: string[] = [];
			for (const logical of rawText.split("\n")) {
				const chunks = wrapTextWithAnsi(logical, textAvail);
				for (const ch of chunks.length > 0 ? chunks : [""]) {
					wrappedRows.push(ch);
				}
			}

			const margin = " ".repeat(outerPad);
			const out: string[] = [];

			for (let i = 0; i < wrappedRows.length; i++) {
				const prefix = i === 0 ? `${spine} ${chevron}` : `${spine}   `;
				let rightAction = "  ";
				if (i === 0 && (isHovered || isCopied) && cardWidth >= 28) {
					rightAction = isCopied
						? fgRgb(140, 194, 101, " ✓ Copied ")
						: light
							? fgRgb(71, 85, 105, " Copy ")
							: fgRgb(148, 168, 198, " Copy ");
				}

				const maxBody = Math.max(4, cardWidth - visibleWidth(prefix) - visibleWidth(rightAction));
				const bodySlice =
					i === 0 && (isHovered || isCopied)
						? truncateToWidth(styleBody(wrappedRows[i]!), maxBody, "…")
						: styleBody(wrappedRows[i]!);
				const gap = " ".repeat(
					Math.max(0, cardWidth - visibleWidth(prefix) - visibleWidth(bodySlice) - visibleWidth(rightAction)),
				);
				const painted = paintSurfaceRow(
					`${prefix}${bodySlice}${gap}${rightAction}`,
					cardWidth,
					cardRgb[0],
					cardRgb[1],
					cardRgb[2],
				);
				out.push(`${margin}${painted}${margin}`);
			}

			self.__conartiCopyHit =
				isHovered || isCopied
					? { xStart: Math.max(0, width - outerPad - 10), xEnd: width - outerPad }
					: undefined;

			if (out.length > 0) {
				out[0] = OSC133_ZONE_START + out[0];
				out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
			}
			return out;
		},
		["pi.grok-ui.hook.chat.userPromptRender"],
	);

	hookMethod(
		proto,
		"handleMouse",
		"transcript.userPromptMouse",
		(self, args) => {
			const event = args[0] as TuiMouseEvent;

			if (event.type === "move") {
				claimHover(self, () => {
					if (self.__conartiHovered) {
						self.__conartiHovered = false;
						requestRender();
					}
				});
				if (!self.__conartiHovered) {
					self.__conartiHovered = true;
					return { handled: true, render: true };
				}
				return undefined;
			}

			if (event.type === "click" && event.button === "left") {
				const hit = self.__conartiCopyHit as { xStart: number; xEnd: number } | undefined;
				if (event.y === 0 && hit && event.x >= hit.xStart && event.x <= hit.xEnd) {
					copyToClipboard(String(self.text ?? "").trim());
					self.__conartiCopied = true;
					requestRender();
					setTimeout(() => {
						self.__conartiCopied = false;
						requestRender();
					}, 1300).unref?.();
					return { handled: true, render: true };
				}
			}

			return undefined;
		},
		["pi.grok-ui.hook.chat.userPromptMouse"],
	);
}
