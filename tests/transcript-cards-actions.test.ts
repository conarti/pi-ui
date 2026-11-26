import { fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { defaultHostExternalOpener, getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxText,
	type InteractiveHarness,
	type SessionEntry,
} from "./harness/interactive-harness.ts";
import { waitForCondition } from "./harness/index.ts";

let harness: InteractiveHarness | undefined;
const tempDirs: string[] = [];

function allocateTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeUserEntry(id: string, parentId: string | null, text: string, ts: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "user",
			content: text,
			timestamp: ts,
		},
	} as SessionEntry;
}

function makeAssistantEntry(
	id: string,
	parentId: string,
	text: string,
	ts: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: ts,
		},
	} as SessionEntry;
}

afterEach(async () => {
	if (harness) {
		await harness.dispose();
		harness = undefined;
	}
	setCapabilityOverrides({});
	resetCapabilitiesCache();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("User Prompt timestamps and in-place Copy hover swap", () => {
	it("renders 25 Nov, 19:56 (and prior-year 25 Nov 2025, 19:56), respects datetime/time/off, keeps vpad=1 blank, and swaps timestamp in-place to Copy -> ✓ Copied without reflow", async () => {
		const nowYear = new Date().getFullYear();
		const currentYearTs = new Date(nowYear, 10, 25, 19, 56).getTime();
		const priorYearTs = new Date(nowYear - 1, 10, 25, 19, 56).getTime();

		const agentDir = allocateTempDir("pi-ui-46-ts-");
		harness = await createInteractiveHarness({
			agentDir,
			theme: "dark",
			width: 78,
			height: 24,
			initialEntries: [
				makeUserEntry(
					"u1",
					null,
					"Refactor the parser module cleanly so wrapped lines never shift on hover",
					currentYearTs,
				),
				makeAssistantEntry("a1", "u1", "Done.", currentYearTs + 1000),
				makeUserEntry("u2", "a1", "Prior year prompt check", priorYearTs),
				makeAssistantEntry("a2", "u2", "Checked.", priorYearTs + 1000),
			],
		});

		await harness.mouseWheel("up", 12, 12, 30);
		const idleScreen = harness.screen();
		const promptHit = idleScreen.findText("› Refactor the parser module");
		expect(promptHit).toBeDefined();
		const row1 = promptHit!.row;
		const row1TextIdle = idleScreen.rowText(row1);
		const row2TextIdle = idleScreen.rowText(row1 + 1);

		/* Верхняя и нижняя строки vpad = 1 всегда пустые */
		expect(idleScreen.rowText(row1 - 1).trim()).toBe("");
		expect(row1TextIdle).toContain("25 Nov, 19:56");
		expect(idleScreen.text()).toContain(`25 Nov ${nowYear - 1}, 19:56`);

		const expectedPromptPrefixEnd = row1TextIdle.indexOf("25 Nov, 19:56");
		expect(expectedPromptPrefixEnd).toBeGreaterThan(10);
		const idleLeftSlice = row1TextIdle.slice(0, expectedPromptPrefixEnd).trimEnd();

		/* Наведение меняет метку времени на Copy на той же строке без сдвига текста */
		await harness.mouseMove(promptHit!.col + 4, row1);
		const hoveredScreen = harness.screen();
		expect(hoveredScreen.rowText(row1 - 1).trim()).toBe("");
		expect(hoveredScreen.rowText(row1)).toContain("Copy");
		expect(hoveredScreen.rowText(row1)).not.toContain("25 Nov, 19:56");
		expect(hoveredScreen.rowText(row1).slice(0, expectedPromptPrefixEnd).trimEnd()).toBe(idleLeftSlice);
		expect(hoveredScreen.rowText(row1 + 1)).toBe(row2TextIdle);

		const copyCol = hoveredScreen.rowText(row1).lastIndexOf("Copy");
		expect(copyCol).toBeGreaterThan(expectedPromptPrefixEnd);
		await harness.mouseClick(copyCol + 1, row1);

		const copiedScreen = harness.screen();
		expect(copiedScreen.rowText(row1 - 1).trim()).toBe("");
		expect(copiedScreen.rowText(row1)).toContain("✓ Copied");
		expect(copiedScreen.rowText(row1).slice(0, expectedPromptPrefixEnd).trimEnd()).toBe(idleLeftSlice);
		expect(copiedScreen.rowText(row1 + 1)).toBe(row2TextIdle);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			"Refactor the parser module cleanly so wrapped lines never shift on hover",
		);

		/* Режим timestamps: "time" показывает только HH:MM */
		writeFileSync(join(agentDir, "pi-ui.json"), `${JSON.stringify({ timestamps: "time" })}\n`, "utf8");
		await harness.mouseMove(2, 1);
		harness.flushFrame(true);
		const timeScreen = harness.screen();
		const u2Hit = timeScreen.findText("› Prior year prompt check");
		expect(u2Hit).toBeDefined();
		expect(timeScreen.rowText(u2Hit!.row)).toContain("19:56");
		expect(timeScreen.rowText(u2Hit!.row)).not.toContain("25 Nov");

		/* Режим timestamps: "off" скрывает метку времени, но оставляет hover Copy без сдвига */
		writeFileSync(join(agentDir, "pi-ui.json"), `${JSON.stringify({ timestamps: "off" })}\n`, "utf8");
		harness.flushFrame(true);
		const offScreen = harness.screen();
		expect(offScreen.rowText(u2Hit!.row)).not.toContain("19:56");
		expect(offScreen.rowText(u2Hit!.row)).not.toContain("25 Nov");
		const offRowText = offScreen.rowText(u2Hit!.row);
		await harness.mouseMove(u2Hit!.col + 4, u2Hit!.row);
		const offHovered = harness.screen();
		const offCopyCol = offHovered.rowText(u2Hit!.row).lastIndexOf("Copy");
		expect(offCopyCol).toBeGreaterThan(20);
		expect(offHovered.rowText(u2Hit!.row).slice(0, offCopyCol)).toBe(offRowText.slice(0, offCopyCol));
	});
});

describe("Skill Chip absorption, SKILL.md Hover Popup, Outline Rail preview, and copy", () => {
	it("absorbs SkillInvocationMessageComponent into clickable /<skill> chips in User Prompt and Sticky Prompt, opens wheel-scrollable SKILL.md popup, shows /<skill> · <text> in Outline Rail, and copies /skill:<name> <text>", async () => {
		const nowYear = new Date().getFullYear();
		const t1 = new Date(nowYear, 10, 25, 19, 56).getTime();
		const t2 = t1 + 60_000;
		const skillBody = [
			"# TDD Discipline",
			...Array.from({ length: 24 }, (_, idx) => `skill-rule-${String(idx + 1).padStart(2, "0")}: test behavior first`),
		].join("\n");
		const skillPrompt = [
			`<skill name="tdd" location="/workspace/.agents/skills/tdd/SKILL.md">`,
			skillBody,
			"</skill>",
			"",
			"Build the markdown serializer",
		].join("\n");
		const longReply = Array.from({ length: 28 }, (_, i) => `reply-line-${i + 1}: detail`).join("\n");

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 24,
			initialEntries: [
				makeUserEntry("u1", null, skillPrompt, t1),
				makeAssistantEntry("a1", "u1", longReply, t1 + 1000),
				makeUserEntry(
					"u2",
					"a1",
					`<skill name="grilling" location="/workspace/.agents/skills/grilling/SKILL.md">\nAsk sharp questions.\n</skill>`,
					t2,
				),
				makeAssistantEntry("a2", "u2", "Ready to grill.", t2 + 1000),
			],
		});

		const scroll = getActiveHostRuntime()!.scroll!;
		await harness.mouseWheel("up", 12, 12, 30);
		const screen = harness.screen();
		expect(screen.text()).not.toContain("[skill]");
		expect(screen.text()).not.toContain("<skill");
		const chipHit = screen.findText("/tdd");
		expect(chipHit).toBeDefined();
		expect(screen.rowText(chipHit!.row)).toContain("Build the markdown serializer");

		/* Копирование карточки сохраняет /skill:<name> <text> без XML */
		await harness.mouseMove(chipHit!.col + 8, chipHit!.row);
		const hovered = harness.screen();
		const copyCol = hovered.rowText(chipHit!.row).lastIndexOf("Copy");
		expect(copyCol).toBeGreaterThan(20);
		await harness.mouseClick(copyCol + 1, chipHit!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			"/skill:tdd Build the markdown serializer",
		);

		/* Клик по /tdd открывает прокручиваемый колесом Hover Popup с путём и содержимым SKILL.md */
		await harness.mouseClick(chipHit!.col + 1, chipHit!.row);
		const popupScreen = harness.screen();
		expect(popupScreen.text()).toContain("SKILL.md");
		expect(popupScreen.text()).toContain("skill-rule-01");
		expect(popupScreen.text()).not.toContain("skill-rule-22");

		const rule01Hit = popupScreen.findText("skill-rule-01");
		expect(rule01Hit).toBeDefined();
		const scrollBeforeWheel = scroll.scrollTop;
		await harness.mouseWheel("down", rule01Hit!.col + 2, rule01Hit!.row, 8);
		const scrolledPopup = harness.screen();
		expect(scrolledPopup.text()).toContain("skill-rule-22");
		expect(scroll.scrollTop).toBe(scrollBeforeWheel);

		await harness.mouseMove(0, 0);
		expect(harness.screen().text()).not.toContain("SKILL.md");

		/* В Sticky Prompt также отображается кликабельный /tdd и открывает SKILL.md попап */
		await harness.mouseWheel("down", 12, 12, 4);
		const stickyScreen = harness.screen();
		expect(stickyScreen.rowText(4)).toContain("/tdd");
		expect(stickyScreen.rowText(4)).toContain("Build the markdown serializer");
		const stickyChipCol = stickyScreen.rowText(4).indexOf("/tdd");
		expect(stickyChipCol).toBeGreaterThan(2);
		await harness.mouseClick(stickyChipCol + 1, 4);
		expect(harness.screen().text()).toContain("skill-rule-01");
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("skill-rule-01");

		/* В Outline Rail предпросмотр показывает /<skill> · <text> */
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		expect(rail.geometry).toBeDefined();
		const tick0Row = 3 + rail.geometry!.ticksY;
		await harness.mouseMove(95, tick0Row);
		expect(harness.screen().text()).toContain("/tdd · Build the markdown serializer");

		/* Карточка без текста после <skill> рендерится как User Prompt с /grilling и копируется как /skill:grilling */
		await harness.mouseWheel("down", 12, 12, 30);
		const endScreen = harness.screen();
		expect(endScreen.text()).not.toContain("[skill]");
		const grillHit = endScreen.findText("/grilling");
		expect(grillHit).toBeDefined();
		await harness.mouseMove(grillHit!.col + 2, grillHit!.row);
		const grillHovered = harness.screen();
		const grillCopyCol = grillHovered.rowText(grillHit!.row).lastIndexOf("Copy");
		expect(grillCopyCol).toBeGreaterThan(20);
		await harness.mouseClick(grillCopyCol + 1, grillHit!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe("/skill:grilling");
	});
});

describe("Post-stream Markdown code, table, and blockquote copy actions", () => {
	it("suppresses all copy bars while streaming, removes legacy row-0 prose Copy, and renders codeFooterBg / hover-only short snippet / table TSV-CSV-MD / blockquote Copy after completion", async () => {
		let activeStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		const fullMarkdown = [
			"Plain assistant prose without a row-0 copy badge.",
			"",
			"```ts",
			"const alpha = 1;",
			"const beta = 2;",
			"```",
			"",
			"```",
			"short-one-liner",
			"```",
			"",
			"```",
			"untagged-1",
			"untagged-2",
			"untagged-3",
			"```",
			"",
			"| Key | Value |",
			"| --- | --- |",
			'| a | "x", y |',
			"",
			"> **Heads up**: check [Pi](https://pi.dev) and `config`.",
		].join("\n");

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 46,
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				activeStream = stream;
				return stream;
			},
		});

		const finalMsg = fauxAssistantMessage([fauxText(fullMarkdown)]);
		const partialMsg = { ...finalMsg, content: [{ type: "text" as const, text: fullMarkdown }] };
		const pendingSubmit = harness.submitInput("Show code, table, and quote");
		await waitForCondition(() => activeStream !== undefined, 4000);
		activeStream!.push({ type: "start", partial: partialMsg });
		activeStream!.push({ type: "text_start", contentIndex: 0, partial: partialMsg });
		activeStream!.push({
			type: "text_delta",
			contentIndex: 0,
			delta: fullMarkdown,
			partial: partialMsg,
		});
		await waitForCondition(() => harness!.screen().text().includes("untagged-3"), 4000);

		/* Во время стриминга ни один блок не показывает кнопки копирования */
		const streamingScreen = harness.screen();
		expect(streamingScreen.text()).not.toContain("[Copy]");
		expect(streamingScreen.text()).not.toContain("[Copy TSV]");
		expect(streamingScreen.text()).not.toContain("ts ·");
		expect(streamingScreen.text()).not.toContain("▎");

		activeStream!.push({
			type: "text_end",
			contentIndex: 0,
			content: fullMarkdown,
			partial: partialMsg,
		});
		activeStream!.push({ type: "done", reason: "stop", message: finalMsg });
		activeStream!.end(finalMsg);
		await pendingSubmit;
		await harness.waitForIdle();

		await harness.mouseWheel("up", 12, 12, 30);
		const settled = harness.screen();

		const proseHit = settled.findText("Plain assistant prose");
		expect(proseHit).toBeDefined();
		await harness.mouseMove(proseHit!.col + 4, proseHit!.row);
		expect(harness.screen().rowText(proseHit!.row)).not.toContain("Copy");

		const tsLineHit = settled.findText("const beta = 2;");
		expect(tsLineHit).toBeDefined();
		expect(settled.rowText(tsLineHit!.row)).not.toContain("▎");
		const tsFooterRow = tsLineHit!.row + 1;
		expect(settled.rowText(tsFooterRow)).toContain("ts · [Copy]");
		const tsCopyCol = settled.rowText(tsFooterRow).indexOf("[Copy]");
		await harness.mouseClick(tsCopyCol + 2, tsFooterRow);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			"const alpha = 1;\nconst beta = 2;",
		);
		expect(harness.screen().rowText(tsFooterRow)).toContain("✓ Copied");

		const shortHit = settled.findText("short-one-liner");
		expect(shortHit).toBeDefined();
		expect(settled.rowText(shortHit!.row)).not.toContain("[Copy]");
		expect(settled.rowText(shortHit!.row + 1).trim()).toBe("");
		await harness.mouseMove(shortHit!.col + 2, shortHit!.row);
		const shortHovered = harness.screen();
		expect(shortHovered.rowText(shortHit!.row)).toContain("[Copy]");
		const shortCopyCol = shortHovered.rowText(shortHit!.row).lastIndexOf("[Copy]");
		await harness.mouseClick(shortCopyCol + 2, shortHit!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe("short-one-liner");

		const untagged3Hit = settled.findText("untagged-3");
		expect(untagged3Hit).toBeDefined();
		const untaggedFooterRow = untagged3Hit!.row + 1;
		expect(settled.rowText(untaggedFooterRow)).toContain("[Copy]");
		expect(settled.rowText(untaggedFooterRow)).not.toContain("·");

		const tableBarHit = settled.findText("[Copy TSV]");
		expect(tableBarHit).toBeDefined();
		const tableRowText = settled.rowText(tableBarHit!.row);
		expect(tableRowText).toContain("[Copy CSV]");
		expect(tableRowText).toContain("[Copy MD]");

		await harness.mouseClick(tableBarHit!.col + 3, tableBarHit!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe('Key\tValue\na\t"x", y');

		const csvCol = tableRowText.indexOf("[Copy CSV]");
		await harness.mouseClick(csvCol + 3, tableBarHit!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe('Key,Value\na,"""x"", y"');

		const mdCol = tableRowText.indexOf("[Copy MD]");
		await harness.mouseClick(mdCol + 3, tableBarHit!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			'| Key | Value |\n| --- | --- |\n| a | "x", y |',
		);

		const quoteHit = settled.findText("Heads up");
		expect(quoteHit).toBeDefined();
		const quoteCopyRow = quoteHit!.row + 1;
		const quoteCopyCol = settled.rowText(quoteCopyRow).indexOf("[Copy]");
		expect(quoteCopyCol).toBeGreaterThanOrEqual(0);
		await harness.mouseClick(quoteCopyCol + 2, quoteCopyRow);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			"**Heads up**: check [Pi](https://pi.dev) and `config`.",
		);
	});
});

describe("Link [text](url) and file path:line [Open] [Copy] Hover Popups", () => {
	it("does not add assistant blockquote actions to third-party transcript notices", async () => {
		harness = await createInteractiveHarness({ extensionFactories: [(pi) => {
			pi.registerCommand("notice", {
				handler: async () => pi.sendMessage({ customType: "notice", content: "> Third-party notice", display: true }),
			});
		}] });
		await harness.submitInput("/notice");
		expect(harness.screen().text()).toContain("Third-party notice");
		expect(harness.screen().text()).not.toContain("[Copy]");
	});

	it.skipIf(process.platform === "win32")("hands the terminal to the configured editor and resumes accepting input", async () => {
		const dir = allocateTempDir("pi-ui-editor-stdio-");
		const script = join(dir, "editor.cjs");
		const output = join(dir, "received.json");
		const path = join(dir, "sample.ts");
		writeFileSync(path, "export const demo = 1;\n");
		writeFileSync(script, `const fs = require('node:fs');\nconst { dev, ino } = fs.fstatSync(0);\nfs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ dev, ino, args: process.argv.slice(2) }));`);
		const visual = process.env.VISUAL;
		try {
			process.env.VISUAL = `"${process.execPath}" "${script}"`;
			let editorDone: ReturnType<typeof defaultHostExternalOpener.openPath> | undefined;
			harness = await createInteractiveHarness({
				externalOpener: {
					...defaultHostExternalOpener,
					openPath: (...args) => editorDone = defaultHostExternalOpener.openPath(...args),
				},
				responses: [fauxAssistantMessage(`Open \`${path}:12:3\`.`)],
			});
			await harness.submitInput("Show source");
			const hit = harness.screen().findText("sample.ts:12:3")!;
			await harness.mouseClick(hit.col + 2, hit.row);
			const open = harness.screen().findText("[Open]")!;
			await harness.mouseClick(open.col + 2, open.row);
			expect(await editorDone).toEqual({ ok: true });
			const { dev, ino } = fstatSync(0);
			expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ dev, ino, args: expect.arrayContaining([path]) });
			await harness.typeText("back in Pi");
			expect(harness.screen().text()).toContain("back in Pi");
		} finally {
			if (visual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = visual;
		}
	});

	it("opens [Open] [Copy] Hover Popup when clicking a hidden-URL Markdown link or path:line reference and invokes HostExternalOpener / clipboard", async () => {
		const openedUrls: string[] = [];
		const openedPaths: Array<{ filePath: string; line?: number; column?: number }> = [];

		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 26,
			externalOpener: {
				async openUrl(url) {
					openedUrls.push(url);
					return { ok: true };
				},
				async openPath(filePath, options) {
					openedPaths.push({ filePath, line: options?.line, column: options?.column });
					return { ok: true };
				},
			},
			responses: [
				fauxAssistantMessage([
					fauxText(
						"Read the [Pi TUI guide](https://pi.dev/docs/tui) and inspect `src/shared/i18n.ts:42:5` for details.",
					),
				]),
			],
		});

		await harness.submitInput("Where are the docs and source?");
		const screen = harness.screen();

		const linkHit = screen.findText("Pi TUI guide");
		expect(linkHit).toBeDefined();
		await harness.mouseClick(linkHit!.col + 3, linkHit!.row);
		expect(openedUrls).toEqual([]);

		const urlPopup = harness.screen();
		expect(urlPopup.text()).toContain("https://pi.dev/docs/tui");
		const copyUrlBtn = urlPopup.findText("[Copy]");
		const openUrlBtn = urlPopup.findText("[Open]");
		expect(copyUrlBtn).toBeDefined();
		expect(openUrlBtn).toBeDefined();

		await harness.mouseClick(copyUrlBtn!.col + 2, copyUrlBtn!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe("https://pi.dev/docs/tui");

		/* Повторно открываем и нажимаем [Open] -> делегирует HostExternalOpener.openUrl */
		await harness.mouseClick(linkHit!.col + 3, linkHit!.row);
		const urlPopup2 = harness.screen();
		const openUrlBtn2 = urlPopup2.findText("[Open]");
		expect(openUrlBtn2).toBeDefined();
		await harness.mouseClick(openUrlBtn2!.col + 2, openUrlBtn2!.row);
		expect(openedUrls).toEqual(["https://pi.dev/docs/tui"]);
		expect(harness.screen().text()).not.toContain("[Open]");

		const pathHit = harness.screen().findText("src/shared/i18n.ts:42:5");
		expect(pathHit).toBeDefined();
		await harness.mouseClick(pathHit!.col + 4, pathHit!.row);

		const pathPopup = harness.screen();
		expect(pathPopup.text()).toContain("src/shared/i18n.ts:42:5");
		const copyPathBtn = pathPopup.findText("[Copy]");
		const openPathBtn = pathPopup.findText("[Open]");
		expect(copyPathBtn).toBeDefined();
		expect(openPathBtn).toBeDefined();

		await harness.mouseClick(copyPathBtn!.col + 2, copyPathBtn!.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe("src/shared/i18n.ts:42:5");

		await harness.mouseClick(pathHit!.col + 4, pathHit!.row);
		const pathPopup2 = harness.screen();
		const openPathBtn2 = pathPopup2.findText("[Open]");
		expect(openPathBtn2).toBeDefined();
		await harness.mouseClick(openPathBtn2!.col + 2, openPathBtn2!.row);
		expect(openedPaths).toHaveLength(1);
		expect(openedPaths[0]!.filePath).toMatch(/src\/shared\/i18n\.ts$/);
		expect(openedPaths[0]!.line).toBe(42);
		expect(openedPaths[0]!.column).toBe(5);

		/* Esc закрывает открытый попап ссылки/пути */
		await harness.mouseClick(pathHit!.col + 4, pathHit!.row);
		expect(harness.screen().text()).toContain("[Open]");
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("[Open]");
	});

	it("opens an existing bare filename on a line without path punctuation", async () => {
		harness = await createInteractiveHarness({ responses: [fauxAssistantMessage("Inspect the Makefile")] });
		writeFileSync(join(harness.cwd, "Makefile"), "all:\n");
		await harness.submitInput("Which file should I inspect?");
		const file = harness.screen().findText("Makefile")!;
		await harness.mouseClick(file.col + 2, file.row);
		const open = harness.screen().findText("[Open]")!;
		expect(open).toBeDefined();
		await harness.mouseClick(open.col + 1, open.row);
		expect(harness.openedExternals).toEqual([{ kind: "path", path: join(harness.cwd, "Makefile") }]);
	});

	it("copies and opens the complete file target from either wrapped fragment", async () => {
		const path = `src/${"deeply-nested-folder/".repeat(4)}component.ts`;
		const target = `${path}:42:7`;
		const opened: Array<{ path: string; line?: number; column?: number }> = [];
		harness = await createInteractiveHarness({
			width: 60, height: 25,
			externalOpener: {
				async openUrl() { return { ok: true }; },
				async openPath(filePath, options) {
					opened.push({ path: filePath, line: options?.line, column: options?.column });
					return { ok: true };
				},
			},
			responses: [fauxAssistantMessage(`Inspect \`${target}\` for details.`)],
		});
		await harness.submitInput("Inspect the file");
		const first = harness.screen().findText("src/deeply")!;
		const last = harness.screen().findText("7 for details.");
		expect(last, harness.screen().text()).toBeDefined();
		expect(first.row).toBeLessThan(last!.row);
		await harness.mouseClick(first.col + 2, first.row);
		const copy = harness.screen().findText("[Copy]")!;
		await harness.mouseClick(copy.col + 2, copy.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(target);
		await harness.mouseClick(last!.col, last!.row);
		const open = harness.screen().findText("[Open]")!;
		await harness.mouseClick(open.col + 2, open.row);
		expect(opened).toEqual([{ path: join(harness.cwd, path), line: 42, column: 7 }]);
	});

	it("scrolls to the complete hidden link target without moving the transcript, and dismisses on pointer leave", async () => {
		const target = `https://pi.dev/${"long-path-segment/".repeat(45)}inspectable-final-suffix`;
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		harness = await createInteractiveHarness({
			width: 86, height: 24,
			responses: [fauxAssistantMessage([
				fauxText(`${Array.from({ length: 28 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n")}\n\n[Inspect target](${target})`),
			])],
		});
		await harness.submitInput("Inspect a hidden URL");
		const link = harness.screen().findText("Inspect target")!;
		await harness.mouseClick(link.col + 2, link.row);
		const popup = harness.screen();
		const start = popup.findText("https://pi.dev/")!;
		expect(popup.text()).not.toContain("inspectable-final-suffix");
		const scroll = getActiveHostRuntime()!.scroll!;
		const transcriptTop = scroll.scrollTop;
		await harness.mouseWheel("down", start.col + 1, start.row, 12);
		expect(harness.screen().text()).toContain("inspectable-final-suffix");
		expect(scroll.scrollTop).toBe(transcriptTop);
		await harness.mouseMove(0, 0);
		expect(harness.screen().text()).not.toContain("[Open]");
	});

	it("also opens [Open] [Copy] popup for [text](url) when terminal OSC 8 hyperlinks are disabled", async () => {
		const openedUrls: string[] = [];
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 22,
			externalOpener: {
				async openUrl(url) {
					openedUrls.push(url);
					return { ok: true };
				},
				async openPath() {
					return { ok: true };
				},
			},
			responses: [
				fauxAssistantMessage([fauxText("Open [Release Notes](https://pi.dev/changelog) now.")]),
			],
		});

		await harness.submitInput("Share release notes");
		const linkHit = harness.screen().findText("Release Notes");
		expect(linkHit).toBeDefined();
		await harness.mouseClick(linkHit!.col + 2, linkHit!.row);

		const popup = harness.screen();
		expect(popup.text()).toContain("https://pi.dev/changelog");
		const openBtn = popup.findText("[Open]");
		expect(openBtn).toBeDefined();
		await harness.mouseClick(openBtn!.col + 2, openBtn!.row);
		expect(openedUrls).toEqual(["https://pi.dev/changelog"]);
	});
});
