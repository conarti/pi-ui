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

describe("prototype #34: pinned Header, User Prompt + Skill Chips, two-tone Markdown code, Sticky Prompt, and Outline Rail", () => {
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

	it("pins Header at row 0 outside ScrollView while Sticky Prompt pins right below it across A / B / C", async () => {
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
		runtime.scroll!.scrollTo(3, { disableFollow: true });
		harness.renderFrame();

		const screenB = harness.screen();
		expect(screenB.rowText(0)).toContain("✦ pi-ui");
		expect(screenB.rowText(0)).toContain("⌃K Palette");

		/* Sticky Prompt sits right below Header (starting at row 1) with Skill Chip badge instead of raw <skill> */
		const topBandTextB = [
			screenB.rowText(1),
			screenB.rowText(2),
			screenB.rowText(3),
			screenB.rowText(4),
		].join("\n");
		expect(topBandTextB).toContain("skill:wayfinder");
		expect(topBandTextB).not.toContain("<skill name=");
		expect(topBandTextB).toContain("Inspect https://github.com/conarti/pi-ui/issues/29");

		/* Variant C renders a 2-row Header (row 0 content + row 1 hairline) and a 1-row condensed Sticky ribbon at row 2 */
		setPrototypeVariant("C");
		runtime.scroll!.invalidate();
		harness.renderFrame();

		const screenC = harness.screen();
		expect(screenC.rowText(0)).toContain("✦ pi-ui");
		expect(screenC.rowText(1)).toContain("────────");
		expect(screenC.rowText(2)).toContain("/wayfinder");
		expect(screenC.rowText(2)).toContain("▾");

		/* Variant A renders a 1-row flush canvas Header and over-scrollbar integrated edge rail */
		setPrototypeVariant("A");
		runtime.scroll!.invalidate();
		harness.renderFrame();

		const screenA = harness.screen();
		expect(screenA.rowText(0)).toContain("✦ pi-ui");
		expect(screenA.rowText(1)).toContain("✦ /wayfinder");
		const rail = runtime.viewportSlots!.rightRail as OutlineRailComponent;
		expect(rail.railPlacement).toBe("over-scrollbar");
	});

	it("renders two-tone Markdown code blocks without ▎ selection glyphs and shows clean Outline Rail Hover Popup", async () => {
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

		const fullPlainB = Array.from({ length: 30 }, (_, r) => harness!.screen().rowText(r)).join("\n");
		expect(fullPlainB).toContain("npm run check");
		expect(fullPlainB).toContain("RIGHT_PLUMB_GUARD");
		/* Code lines must not prefix ▎ before code statements */
		expect(fullPlainB).not.toContain("▎ export const RIGHT_PLUMB_GUARD");
		expect(fullPlainB).not.toContain("▎ npm run check");

		/* Hovering the first tick on Outline Rail opens the opaque Turn #1 Hover Popup with /wayfinder preview */
		const rail = runtime.viewportSlots!.rightRail as OutlineRailComponent;
		const geo = rail.geometry!;
		expect(geo).toBeDefined();
		const railScreenX = 110 - 3;
		const tickScreenY = 1 + geo.ticksY;
		harness.terminal.sendInput(formatSgrMouse(35, railScreenX, tickScreenY, false));
		harness.renderFrame();

		const hoverDump = Array.from({ length: 30 }, (_, r) => harness!.screen().rowText(r)).join("\n");
		expect(hoverDump).toContain("Turn #1");
		expect(hoverDump).toContain("/wayfinder · Inspect");
		expect(hoverDump).not.toContain("<skill");
	});
});
