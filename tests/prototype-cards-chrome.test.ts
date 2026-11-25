import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { setPrototypeVariant } from "../src/features/transcript/prototype-state.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { extractSkillInvocations, hideSkillPreviewPopup } from "../src/shared/skill-tags.ts";
import {
	createInteractiveHarness,
	formatSgrMouse,
	makeAssistantEntry,
	makeUserEntry,
	type InteractiveHarness,
} from "./harness/index.ts";

function buildTallProse(count: number): string {
	return Array.from({ length: count }, (_, i) => `Assistant explanation row ${i + 1}`).join("\n");
}

const SAMPLE_SKILL_PROMPT = `<skill name="wayfinder" location="/Users/macbook/Projects/pi-ui/.agents/skills/wayfinder/SKILL.md">
References are relative to /Users/macbook/Projects/pi-ui/.agents/skills/wayfinder.

Wayfinder charts decision maps on the issue tracker.
</skill>

Inspect https://github.com/conarti/pi-ui/issues/29
Keep the viewport header pinned outside ScrollView
Ensure Sticky Prompt sits cleanly underneath Header
Verify Outline Rail previews never show raw XML`;

const SAMPLE_CODE_REPLY = [
	"Run a quick check:",
	"",
	"```",
	"npm run check",
	"```",
	"",
	"And inspect the typed helper:",
	"",
	"```ts",
	"export const RIGHT_PLUMB_GUARD = 4;",
	"export function alignViewport(width: number): number {",
	"  return Math.max(12, width - RIGHT_PLUMB_GUARD);",
	"}",
	"```",
	"",
	buildTallProse(20),
].join("\n");

describe("prototype #34: pinned Header, Context modal, User Prompt + Skill Chips, Markdown code, Sticky Prompt, and Outline Rail", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		hideSkillPreviewPopup();
		setPrototypeVariant("off");
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it("parses <skill> tags into clean copy text and Outline Rail preview text without raw XML", () => {
		const parsed = extractSkillInvocations(SAMPLE_SKILL_PROMPT);
		expect(parsed.skills).toHaveLength(1);
		expect(parsed.skills[0]?.name).toBe("wayfinder");
		expect(parsed.userText).toContain("Inspect https://github.com/conarti/pi-ui/issues/29");
		expect(parsed.userText).not.toContain("<skill");
		expect(parsed.cleanCopyText.startsWith("/skill:wayfinder Inspect")).toBe(true);
		expect(parsed.previewText.startsWith("/wayfinder · Inspect")).toBe(true);
	});

	it("pins Header at row 0 with hover-morphing Context indicator + 3-tab Context modal, Sticky Prompt at row 2, and Shortcuts Bar", async () => {
		const t1 = Date.UTC(2026, 10, 25, 13, 52, 0);
		const t2 = t1 + 60_000;
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 110,
			height: 28,
			initialEntries: [
				makeUserEntry("u1", null, SAMPLE_SKILL_PROMPT, t1),
				makeAssistantEntry("a1", "u1", SAMPLE_CODE_REPLY, t1 + 1000),
				makeUserEntry("u2", "a1", "Short follow-up prompt", t2),
				makeAssistantEntry("a2", "u2", buildTallProse(22), t2 + 1000),
			],
		});

		setPrototypeVariant("B");
		const runtime = getActiveHostRuntime()!;
		runtime.scroll!.scrollTo(8, { disableFollow: true });
		harness.renderFrame();

		const screen = harness.screen();
		/* Row 0: workspace path on left + used / limit context indicator on right; Row 1: pure canvas air */
		expect(screen.rowText(0)).toMatch(/(?:~\/|\/)/u);
		expect(screen.rowText(0)).toMatch(/\d+(?:\.\d+)?k?\s*\/\s*\d+k/u);
		expect(screen.rowText(0)).not.toContain("[Dashboard]");
		expect(screen.rowText(1).trim()).toBe("");

		/* Sticky Prompt sits at row 2 with /wayfinder chip (absorbs host [skill] box + raw XML) and centered ▲ below */
		const topBand = Array.from({ length: 8 }, (_, r) => screen.rowText(r + 2)).join("\n");
		expect(topBand).toContain("/wayfinder");
		expect(topBand).not.toContain("<skill name=");
		expect(topBand).not.toContain("[skill]");
		expect(topBand).toContain("Inspect https://github.com/conarti/pi-ui/issues/29");
		expect(topBand).toContain("▲");

		/* Composer bottom border & Shortcuts Bar at bottom of screen */
		const bottomBand = Array.from({ length: 5 }, (_, r) => screen.rowText(23 + r)).join("\n");
		expect(bottomBand).toContain("always-approve");
		expect(bottomBand).toContain("Shift+Tab:mode");

		/* Hovering top-right context indicator morphs it in-place to a percentage progress bar */
		await harness.mouseMove(105, 0);
		expect(harness.screen().rowText(0)).toMatch(/\d+\.\d+%/u);

		/* Minimal centered ▼ replaces stock Jump-to-latest banner when scrolled up */
		const fullScrolled = Array.from({ length: 28 }, (_, r) => harness!.screen().rowText(r)).join("\n");
		expect(fullScrolled).not.toContain("Jump to latest message");
		expect(fullScrolled).toContain("▼");

		/* Clicking top-right context indicator opens the 3-tab Context usage / Session usage / Session info modal */
		await harness.mouseClick(105, 0);

		const modalDump = Array.from({ length: 28 }, (_, r) => harness!.screen().rowText(r)).join("\n");
		expect(modalDump).toContain("Context usage");
		expect(modalDump).toContain("Session usage");
		expect(modalDump).toContain("Session info");
		expect(modalDump).toContain("[x]");

		/* Close modal with Escape */
		await harness.sendInput("\x1b");
	});

	it("renders two-tone post-block Markdown code blocks without ▎ selection glyphs and minimal Outline Rail Hover Popup", async () => {
		const t1 = Date.UTC(2026, 10, 25, 14, 10, 0);
		const t2 = t1 + 60_000;
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 110,
			height: 30,
			initialEntries: [
				makeUserEntry("u1", null, SAMPLE_SKILL_PROMPT, t1),
				makeAssistantEntry("a1", "u1", SAMPLE_CODE_REPLY, t1 + 1000),
				makeUserEntry("u2", "a1", "Verify code block selection", t2),
				makeAssistantEntry("a2", "u2", "Confirmed.", t2 + 1000),
			],
		});

		setPrototypeVariant("B");
		const runtime = getActiveHostRuntime()!;
		runtime.scroll!.scrollTo(0, { disableFollow: true });
		harness.renderFrame();

		const fullPlain = Array.from({ length: 30 }, (_, r) => harness!.screen().rowText(r)).join("\n");
		expect(fullPlain).toContain("npm run check");
		expect(fullPlain).toContain("RIGHT_PLUMB_GUARD");
		expect(fullPlain).toContain("[Copy]");
		/* Code lines must not prefix ▎ before code statements */
		expect(fullPlain).not.toContain("▎ export const RIGHT_PLUMB_GUARD");
		expect(fullPlain).not.toContain("▎ npm run check");

		/* Outline Rail uses over-scrollbar placement in the 2-col right canvas gutter */
		const rail = runtime.viewportSlots!.rightRail as OutlineRailComponent;
		expect(rail.railPlacement).toBe("over-scrollbar");
		const geo = rail.geometry!;
		expect(geo).toBeDefined();
		const railScreenX = 110 - 2;
		const tickScreenY = 2 + geo.ticksY;
		harness.terminal.sendInput(formatSgrMouse(35, railScreenX, tickScreenY, false));
		harness.renderFrame();

		const hoverDump = Array.from({ length: 30 }, (_, r) => harness!.screen().rowText(r)).join("\n");
		expect(hoverDump).toContain("/wayfinder · Inspect");
		expect(hoverDump).not.toContain("<skill");
		expect(hoverDump).not.toContain("Turn #1");
	});
});
