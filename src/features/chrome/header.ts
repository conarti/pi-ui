import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fgRgb, type HitBox } from "../../shared/ansi.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getStore } from "../../shared/session-store.ts";
import { showCommandPalette } from "../command-palette/index.ts";

function detectGitBranch(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 300,
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

export function mountSessionHeader(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const projectName = basename(ctx.cwd) || ctx.cwd;
	const gitBranch = detectGitBranch(ctx.cwd);

	ctx.ui.setHeader((_tui, theme) => {
		let hovered = false;
		let menuHit: HitBox | null = null;
		const owner = {};

		return {
			invalidate() {},
			render(width: number): string[] {
				menuHit = null;
				if (width < 28) return [];

				const brand = `${fgRgb(97, 175, 239, "◈")} ${theme.bold("pi")} ${theme.fg("dim", `v${VERSION} · @conarti/pi-ui`)}`;
				const proj = `${theme.fg("muted", projectName)}${gitBranch ? ` ${fgRgb(86, 182, 194, `(${gitBranch})`)}` : ""}`;
				const menuText = hovered ? fgRgb(125, 207, 255, "⌃K меню") : theme.fg("dim", "⌃K меню");

				const left = `  ${brand}  ${theme.fg("dim", "·")}  ${proj}`;
				const right = `${menuText}  `;
				const gapLen = Math.max(2, width - visibleWidth(left) - visibleWidth(right));

				if (visibleWidth(left) + visibleWidth(right) + 2 <= width) {
					const xStart = visibleWidth(left) + gapLen;
					menuHit = {
						id: "menu",
						xStart,
						xEnd: xStart + visibleWidth(menuText),
						y: 0,
						onClick: () => void showCommandPalette(pi, ctx),
					};
					return [`${left}${" ".repeat(gapLen)}${right}`];
				}

				return [truncateToWidth(left, width, "…")];
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "move") {
					const onMenu = Boolean(
						menuHit && event.y === 0 && event.x >= menuHit.xStart && event.x <= menuHit.xEnd,
					);
					if (onMenu) {
						claimHover(owner, () => {
							if (hovered) {
								hovered = false;
								getStore().requestRender?.();
							}
						});
					}
					if (onMenu !== hovered) {
						hovered = onMenu;
						return { handled: true, render: true };
					}
					return undefined;
				}
				if (
					event.type === "click" &&
					event.button === "left" &&
					menuHit &&
					event.y === 0 &&
					event.x >= menuHit.xStart &&
					event.x <= menuHit.xEnd
				) {
					menuHit.onClick();
					return { handled: true };
				}
				return undefined;
			},
		};
	});
}
