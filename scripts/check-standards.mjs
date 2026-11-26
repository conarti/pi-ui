import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareSemver,
	EXPECTED_PI_HOST_VERSION,
	HOST_PEER_PACKAGES,
	readHostPiVersion,
} from "./resolve-host-pi.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BANNED_COMMIT_PATTERNS = [
	{ label: "Co-Authored-By trailer", regex: /^Co-Authored-By:/im },
	{ label: "Generated-with/by phrase", regex: /\bGenerated\s+(?:with|by)\b/i },
	{ label: "em-dash or en-dash", regex: /[\u2013\u2014]/ },
	{ label: "double hyphen in prose", regex: /(?:^|\s)--(?:\s|$)/m },
];

const DELETED_FAKE_HARNESS_FILES = [
	"tests/harness/fake-tui.ts",
	"tests/harness/fake-theme.ts",
	"tests/harness/extension-harness.ts",
];

const PURE_UNIT_TEST_FILES = new Set([
	"tests/animation-scheduler.test.ts",
	"tests/check-standards.test.ts",
	"tests/host-peers.test.ts",
	"tests/keyboard-layout.test.ts",
	"tests/prompt-chips.test.ts",
	"tests/quotes.test.ts",
	"tests/shell-analysis.test.ts",
	"tests/viewport-chrome-geometry.test.ts",
]);

/* Только перечисленные граничные модули могут обращаться к node:fs; рендер-компоненты читают конфиг через pi-ui-config.ts (ADR-0008) */
const ALLOWED_FS_SRC_FILES = new Set([
	"src/features/prompt-chips/clipboard.ts",
	"src/features/prompt-chips/index.ts",
	"src/features/prompt-suggestion/supersede-external.ts",
	"src/features/tool-calls/command.ts",
	"src/features/tool-calls/config.ts",
	"src/features/tool-calls/index.ts",
	"src/features/tool-calls/runtime.ts",
	"src/features/tool-calls/thinking.ts",
	"src/shared/atomic-config-file.ts",
	"src/shared/link-targets.ts",
	"src/shared/pi-ui-config.ts",
	"src/shared/session-workflow.ts",
	"src/shared/skill-tags.ts",
]);

const NODE_FS_SPECIFIER_RE = /^(?:node:)?fs(?:\/promises)?$/;

const BANNED_FAKE_MODULE_RE = /(?:^|\/)(?:fake-tui|fake-theme|extension-harness)(?:\.[cm]?[jt]s)?$/;
const BANNED_TEST_SYMBOL_RE =
	/\b(FakeTui|ExtensionHarness|createExtensionHarness|createFakeTheme|createDarkTheme|createLightTheme|setHostRuntimeAdapter|HostRuntimeAdapter)\b/g;
const BANNED_SRC_SYMBOL_RE =
	/\b(setHostRuntimeAdapter|HostRuntimeAdapter|FakeTui|ExtensionHarness|createExtensionHarness|createFakeTheme)\b/g;
const NON_MEMBER_BRACKET_PREDECESSORS = new Set([
	"=",
	",",
	"(",
	"{",
	"[",
	":",
	";",
	"?",
	"&&",
	"||",
	"??",
	"return",
	"throw",
	"yield",
	"case",
	"of",
	"in",
]);

/**
 * Возвращает 1-индексированные номера строк с однострочными комментариями,
 * пропуская строки, шаблонные литералы, регулярные выражения и блочные комментарии.
 */
export function findSingleLineCommentLines(sourceText) {
	const foundLines = new Set();
	const len = sourceText.length;
	let i = 0;
	let line = 1;
	let canStartRegex = true;
	const templateBraceDepthStack = [];

	const advanceLine = (ch, nextCh) => {
		if (ch === "\r") {
			line += 1;
			if (nextCh === "\n") i += 1;
			return true;
		}
		if (ch === "\n") {
			line += 1;
			return true;
		}
		return false;
	};

	if (sourceText.startsWith("#!")) {
		while (i < len && sourceText[i] !== "\n" && sourceText[i] !== "\r") i += 1;
	}

	while (i < len) {
		const ch = sourceText[i];
		const next = sourceText[i + 1];

		if (advanceLine(ch, next)) {
			i += 1;
			continue;
		}

		if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v") {
			i += 1;
			continue;
		}

		if (ch === "/" && next === "/") {
			foundLines.add(line);
			i += 2;
			while (i < len && sourceText[i] !== "\n" && sourceText[i] !== "\r") i += 1;
			continue;
		}

		if (ch === "/" && next === "*") {
			i += 2;
			while (i < len && !(sourceText[i] === "*" && sourceText[i + 1] === "/")) {
				if (advanceLine(sourceText[i], sourceText[i + 1])) {
					i += 1;
					continue;
				}
				i += 1;
			}
			i += 2;
			continue;
		}

		if (ch === "'" || ch === '"') {
			const quote = ch;
			i += 1;
			while (i < len && sourceText[i] !== quote) {
				if (sourceText[i] === "\\") {
					i += 1;
					if (i < len) advanceLine(sourceText[i], sourceText[i + 1]);
					i += 1;
					continue;
				}
				if (advanceLine(sourceText[i], sourceText[i + 1])) {
					i += 1;
					break;
				}
				i += 1;
			}
			i += 1;
			canStartRegex = false;
			continue;
		}

		if (ch === "`") {
			i += 1;
			while (i < len && sourceText[i] !== "`") {
				if (sourceText[i] === "\\") {
					i += 1;
					if (i < len) advanceLine(sourceText[i], sourceText[i + 1]);
					i += 1;
					continue;
				}
				if (sourceText[i] === "$" && sourceText[i + 1] === "{") {
					templateBraceDepthStack.push(0);
					i += 2;
					canStartRegex = true;
					break;
				}
				if (advanceLine(sourceText[i], sourceText[i + 1])) {
					i += 1;
					continue;
				}
				i += 1;
			}
			if (sourceText[i] === "`") {
				i += 1;
				canStartRegex = false;
			}
			continue;
		}

		if (templateBraceDepthStack.length > 0) {
			if (ch === "{") {
				templateBraceDepthStack[templateBraceDepthStack.length - 1] += 1;
				i += 1;
				canStartRegex = true;
				continue;
			}
			if (ch === "}") {
				const depth = templateBraceDepthStack[templateBraceDepthStack.length - 1];
				if (depth > 0) {
					templateBraceDepthStack[templateBraceDepthStack.length - 1] = depth - 1;
					i += 1;
					canStartRegex = false;
					continue;
				}
				templateBraceDepthStack.pop();
				i += 1;
				while (i < len && sourceText[i] !== "`") {
					if (sourceText[i] === "\\") {
						i += 1;
						if (i < len) advanceLine(sourceText[i], sourceText[i + 1]);
						i += 1;
						continue;
					}
					if (sourceText[i] === "$" && sourceText[i + 1] === "{") {
						templateBraceDepthStack.push(0);
						i += 2;
						canStartRegex = true;
						break;
					}
					if (advanceLine(sourceText[i], sourceText[i + 1])) {
						i += 1;
						continue;
					}
					i += 1;
				}
				if (sourceText[i] === "`") {
					i += 1;
					canStartRegex = false;
				}
				continue;
			}
		}

		if (ch === "/" && canStartRegex) {
			i += 1;
			let inCharClass = false;
			while (i < len) {
				const rc = sourceText[i];
				if (rc === "\n" || rc === "\r") break;
				if (rc === "\\") {
					i += 2;
					continue;
				}
				if (rc === "[") inCharClass = true;
				else if (rc === "]") inCharClass = false;
				else if (rc === "/" && !inCharClass) {
					i += 1;
					while (i < len && /[a-z]/i.test(sourceText[i])) i += 1;
					break;
				}
				i += 1;
			}
			canStartRegex = false;
			continue;
		}

		if (/[A-Za-z0-9_$]/.test(ch)) {
			const start = i;
			i += 1;
			while (i < len && /[A-Za-z0-9_$]/.test(sourceText[i])) i += 1;
			const word = sourceText.slice(start, i);
			canStartRegex =
				word === "return" ||
				word === "throw" ||
				word === "case" ||
				word === "typeof" ||
				word === "void" ||
				word === "delete" ||
				word === "in" ||
				word === "of" ||
				word === "instanceof" ||
				word === "new" ||
				word === "await" ||
				word === "yield";
			continue;
		}

		canStartRegex = "([{:;,=!?&|+-*%^~<>".includes(ch);
		i += 1;
	}

	return [...foundLines].sort((a, b) => a - b);
}

/**
 * Маскирует комментарии и строковые/шаблонные/регулярные литералы пробелами с сохранением переводов строк,
 * одновременно извлекая реальные спецификаторы модулей import/export и строковые обращения к свойствам `obj["prop"]`.
 */
function scanTypeScriptCode(sourceText) {
	const chars = Array.from(sourceText);
	const out = new Array(chars.length).fill(" ");
	const moduleSpecifiers = [];
	const bracketProperties = [];
	const len = sourceText.length;
	let i = 0;
	let line = 1;
	let canStartRegex = true;
	let prevToken = null;
	let prevPrevToken = null;
	const templateBraceDepthStack = [];

	const pushToken = (tok) => {
		prevPrevToken = prevToken;
		prevToken = tok;
	};

	const copyBreak = (idx) => {
		const ch = sourceText[idx];
		if (ch === "\r") {
			out[idx] = "\r";
			line += 1;
			if (sourceText[idx + 1] === "\n") {
				out[idx + 1] = "\n";
				return 2;
			}
			return 1;
		}
		if (ch === "\n") {
			out[idx] = "\n";
			line += 1;
			return 1;
		}
		return 0;
	};

	if (sourceText.startsWith("#!")) {
		while (i < len && sourceText[i] !== "\n" && sourceText[i] !== "\r") i += 1;
	}

	while (i < len) {
		const ch = sourceText[i];
		const next = sourceText[i + 1];

		const nlStep = copyBreak(i);
		if (nlStep > 0) {
			i += nlStep;
			continue;
		}

		if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v") {
			i += 1;
			continue;
		}

		if (ch === "/" && next === "/") {
			i += 2;
			while (i < len && sourceText[i] !== "\n" && sourceText[i] !== "\r") i += 1;
			continue;
		}

		if (ch === "/" && next === "*") {
			i += 2;
			while (i < len && !(sourceText[i] === "*" && sourceText[i + 1] === "/")) {
				const step = copyBreak(i);
				if (step > 0) {
					i += step;
					continue;
				}
				i += 1;
			}
			i += 2;
			continue;
		}

		if (ch === "'" || ch === '"') {
			const quote = ch;
			const startLine = line;
			out[i] = quote;
			i += 1;
			const contentStart = i;
			while (i < len && sourceText[i] !== quote) {
				if (sourceText[i] === "\\") {
					i += 1;
					if (i < len) {
						const step = copyBreak(i);
						i += step > 0 ? step : 1;
					}
					continue;
				}
				const step = copyBreak(i);
				if (step > 0) {
					i += step;
					break;
				}
				i += 1;
			}
			const rawValue = sourceText.slice(contentStart, i);
			if (sourceText[i] === quote) {
				out[i] = quote;
				i += 1;
			}
			if (
				prevToken === "from" ||
				prevToken === "import" ||
				(prevToken === "(" &&
					(prevPrevToken === "import" ||
						prevPrevToken === "require" ||
						prevPrevToken === "mock" ||
						prevPrevToken === "doMock"))
			) {
				moduleSpecifiers.push({ line: startLine, value: rawValue });
			} else if (
				prevToken === "[" &&
				prevPrevToken !== null &&
				!NON_MEMBER_BRACKET_PREDECESSORS.has(prevPrevToken)
			) {
				bracketProperties.push({ line: startLine, value: rawValue });
			}
			pushToken("<string>");
			canStartRegex = false;
			continue;
		}

		if (ch === "`") {
			out[i] = "`";
			i += 1;
			while (i < len && sourceText[i] !== "`") {
				if (sourceText[i] === "\\") {
					i += 1;
					if (i < len) {
						const step = copyBreak(i);
						i += step > 0 ? step : 1;
					}
					continue;
				}
				if (sourceText[i] === "$" && sourceText[i + 1] === "{") {
					out[i] = "$";
					out[i + 1] = "{";
					templateBraceDepthStack.push(0);
					pushToken("${");
					i += 2;
					canStartRegex = true;
					break;
				}
				const step = copyBreak(i);
				if (step > 0) {
					i += step;
					continue;
				}
				i += 1;
			}
			if (sourceText[i] === "`") {
				out[i] = "`";
				i += 1;
				pushToken("<template>");
				canStartRegex = false;
			}
			continue;
		}

		if (templateBraceDepthStack.length > 0) {
			if (ch === "{") {
				templateBraceDepthStack[templateBraceDepthStack.length - 1] += 1;
				out[i] = "{";
				pushToken("{");
				i += 1;
				canStartRegex = true;
				continue;
			}
			if (ch === "}") {
				const depth = templateBraceDepthStack[templateBraceDepthStack.length - 1];
				if (depth > 0) {
					templateBraceDepthStack[templateBraceDepthStack.length - 1] = depth - 1;
					out[i] = "}";
					pushToken("}");
					i += 1;
					canStartRegex = false;
					continue;
				}
				templateBraceDepthStack.pop();
				out[i] = "}";
				i += 1;
				while (i < len && sourceText[i] !== "`") {
					if (sourceText[i] === "\\") {
						i += 1;
						if (i < len) {
							const step = copyBreak(i);
							i += step > 0 ? step : 1;
						}
						continue;
					}
					if (sourceText[i] === "$" && sourceText[i + 1] === "{") {
						out[i] = "$";
						out[i + 1] = "{";
						templateBraceDepthStack.push(0);
						pushToken("${");
						i += 2;
						canStartRegex = true;
						break;
					}
					const step = copyBreak(i);
					if (step > 0) {
						i += step;
						continue;
					}
					i += 1;
				}
				if (sourceText[i] === "`") {
					out[i] = "`";
					i += 1;
					pushToken("<template>");
					canStartRegex = false;
				}
				continue;
			}
		}

		if (ch === "/" && canStartRegex) {
			out[i] = "/";
			i += 1;
			let inCharClass = false;
			while (i < len) {
				const rc = sourceText[i];
				if (rc === "\n" || rc === "\r") break;
				if (rc === "\\") {
					i += 2;
					continue;
				}
				if (rc === "[") inCharClass = true;
				else if (rc === "]") inCharClass = false;
				else if (rc === "/" && !inCharClass) {
					out[i] = "/";
					i += 1;
					while (i < len && /[a-z]/i.test(sourceText[i])) i += 1;
					break;
				}
				i += 1;
			}
			pushToken("<regex>");
			canStartRegex = false;
			continue;
		}

		if (/[A-Za-z0-9_$]/.test(ch)) {
			const start = i;
			out[i] = ch;
			i += 1;
			while (i < len && /[A-Za-z0-9_$]/.test(sourceText[i])) {
				out[i] = sourceText[i];
				i += 1;
			}
			const word = sourceText.slice(start, i);
			pushToken(word);
			canStartRegex =
				word === "return" ||
				word === "throw" ||
				word === "case" ||
				word === "typeof" ||
				word === "void" ||
				word === "delete" ||
				word === "in" ||
				word === "of" ||
				word === "instanceof" ||
				word === "new" ||
				word === "await" ||
				word === "yield";
			continue;
		}

		out[i] = ch;
		pushToken(ch);
		canStartRegex = "([{:;,=!?&|+-*%^~<>".includes(ch);
		i += 1;
	}

	const codeText = out.join("");
	const lineStarts = [0];
	for (let idx = 0; idx < codeText.length; idx += 1) {
		if (codeText[idx] === "\n") {
			lineStarts.push(idx + 1);
		}
	}

	const lineAtOffset = (offset) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (lineStarts[mid] <= offset) {
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return hi + 1;
	};

	return { codeText, moduleSpecifiers, bracketProperties, lineAtOffset };
}

/**
 * Проверяет исходный код теста на запрещённые фейки хоста, приведения `as unknown as TUI`,
 * чтение приватного `.overlayStack` и прямые вызовы `.handleMouse(...)` в интеграционных сьютах (ADR-0006).
 */
export function findTestAntiMockViolations(sourceText, options = {}) {
	const { isPureUnit = false } = options;
	const { codeText, moduleSpecifiers, bracketProperties, lineAtOffset } =
		scanTypeScriptCode(sourceText);
	const violations = [];

	for (const spec of moduleSpecifiers) {
		if (BANNED_FAKE_MODULE_RE.test(spec.value)) {
			violations.push({
				line: spec.line,
				message: `do not import removed fake-host module "${spec.value}" (use tests/harness/interactive-harness.ts per ADR-0006)`,
			});
		}
	}

	for (const prop of bracketProperties) {
		if (prop.value === "overlayStack") {
			violations.push({
				line: prop.line,
				message:
					"do not access private .overlayStack in tests (use hasBlockingModalOverlay(tui) or terminal screen assertions)",
			});
		}
		if (prop.value === "hasOverlayEntries") {
			violations.push({
				line: prop.line,
				message:
					"do not access .hasOverlayEntries; use hasBlockingModalOverlay(tui) from src/shared/modal-card.ts",
			});
		}
	}

	for (const match of codeText.matchAll(BANNED_TEST_SYMBOL_RE)) {
		violations.push({
			line: lineAtOffset(match.index ?? 0),
			message: `do not reference removed fake-host symbol "${match[1]}" in tests (ADR-0006)`,
		});
	}

	for (const match of codeText.matchAll(/\bas\s+unknown\s+as\s+TUI\b/g)) {
		violations.push({
			line: lineAtOffset(match.index ?? 0),
			message:
				'do not cast fake objects with "as unknown as TUI" in tests (boot real InteractiveMode per ADR-0006)',
		});
	}

	for (const match of codeText.matchAll(/\.\s*asTui\s*\(/g)) {
		violations.push({
			line: lineAtOffset(match.index ?? 0),
			message:
				"do not call legacy .asTui() cast helper in tests (boot real InteractiveMode per ADR-0006)",
		});
	}

	for (const match of codeText.matchAll(/\.\s*overlayStack\b/g)) {
		violations.push({
			line: lineAtOffset(match.index ?? 0),
			message:
				"do not access private .overlayStack in tests (use hasBlockingModalOverlay(tui) or terminal screen assertions)",
		});
	}

	for (const match of codeText.matchAll(/\.\s*hasOverlayEntries\b/g)) {
		violations.push({
			line: lineAtOffset(match.index ?? 0),
			message:
				"do not access .hasOverlayEntries; use hasBlockingModalOverlay(tui) from src/shared/modal-card.ts",
		});
	}

	if (!isPureUnit) {
		for (const match of codeText.matchAll(/\.\s*handleMouse\s*(?:\?\.\s*)?\(/g)) {
			violations.push({
				line: lineAtOffset(match.index ?? 0),
				message:
					"do not call component .handleMouse(...) directly in integration tests; drive SGR mouse input through VirtualTerminal / InteractiveHarness",
			});
		}
	}

	return violations.sort((a, b) => a.line - b.line);
}

/**
 * Находит строки с нестандартным символом закрытия `✕` (`\u2715`) вне комментариев,
 * чтобы все модалки, баннеры и попапы использовали единый глиф `×` (`[×]`).
 */
export function findDisallowedCloseGlyphLines(sourceText) {
	const out = Array.from(sourceText);
	const len = sourceText.length;
	let i = 0;

	const skipBreak = (idx) => {
		if (sourceText[idx] === "\r") return sourceText[idx + 1] === "\n" ? 2 : 1;
		if (sourceText[idx] === "\n") return 1;
		return 0;
	};

	while (i < len) {
		const step = skipBreak(i);
		if (step > 0) {
			i += step;
			continue;
		}
		const ch = sourceText[i];
		const next = sourceText[i + 1];
		if (ch === "/" && next === "/") {
			while (i < len && sourceText[i] !== "\n" && sourceText[i] !== "\r") {
				out[i] = " ";
				i += 1;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			out[i] = " ";
			out[i + 1] = " ";
			i += 2;
			while (i < len && !(sourceText[i] === "*" && sourceText[i + 1] === "/")) {
				const br = skipBreak(i);
				if (br > 0) {
					i += br;
					continue;
				}
				out[i] = " ";
				i += 1;
			}
			if (i < len) {
				out[i] = " ";
				if (i + 1 < len) out[i + 1] = " ";
				i += 2;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			const quote = ch;
			i += 1;
			while (i < len && sourceText[i] !== quote) {
				if (sourceText[i] === "\\") {
					i += 2;
					continue;
				}
				i += 1;
			}
			i += 1;
			continue;
		}
		i += 1;
	}

	const stripped = out.join("");
	const lines = stripped.split(/\r?\n/);
	const badLines = [];
	for (let idx = 0; idx < lines.length; idx += 1) {
		if (/\u2715|\\u2715/i.test(lines[idx])) {
			badLines.push(idx + 1);
		}
	}
	return badLines;
}

export function validateCommitMessage(rawMessage) {
	const cleaned = rawMessage
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("#"))
		.join("\n")
		.trim();

	const errors = [];
	for (const rule of BANNED_COMMIT_PATTERNS) {
		if (rule.regex.test(cleaned)) {
			errors.push(`Commit message contains prohibited ${rule.label}`);
		}
	}
	return errors;
}

function walkFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walkFiles(full) : [full];
	});
}

function parseAddedLinesFromGitDiff(rootDir) {
	let diffOutput = "";
	try {
		diffOutput = execFileSync(
			"git",
			["diff", "HEAD", "--unified=0", "--no-color", "--", "src", "tests"],
			{ cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch {
		return new Map();
	}

	const addedByFile = new Map();
	let currentFile = null;

	for (const line of diffOutput.split(/\r?\n/)) {
		if (line.startsWith("+++ b/")) {
			currentFile = line.slice(6).trim();
			continue;
		}
		if (!currentFile || !currentFile.endsWith(".ts")) continue;
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!match) continue;
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		if (count <= 0) continue;
		let set = addedByFile.get(currentFile);
		if (!set) {
			set = new Set();
			addedByFile.set(currentFile, set);
		}
		for (let ln = start; ln < start + count; ln += 1) {
			set.add(ln);
		}
	}

	return addedByFile;
}

export function checkRepositoryStandards(rootDir = ROOT_DIR) {
	const errors = [];

	if (resolve(rootDir) === ROOT_DIR) {
		const installedHostVersion = readHostPiVersion();
		if (compareSemver(installedHostVersion, EXPECTED_PI_HOST_VERSION) < 0) {
			errors.push(
				`Host @earendil-works/pi-coding-agent (${installedHostVersion}) is older than CI target ${EXPECTED_PI_HOST_VERSION}; upgrade global pi for CI parity`,
			);
		}
	}

	/* 1. Изоляция host peer пакетов и ресурсов пакета */
	if (existsSync(join(rootDir, "node_modules", "@earendil-works"))) {
		errors.push("node_modules/@earendil-works must not exist (host-provided peer invariant)");
	}
	if (existsSync(join(rootDir, "node_modules", "typebox"))) {
		errors.push("node_modules/typebox must not exist (host-provided peer invariant)");
	}

	const pkgJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
	for (const peer of HOST_PEER_PACKAGES) {
		if (pkgJson.peerDependencies?.[peer] !== "*") {
			errors.push(`package.json must declare ${peer} in peerDependencies as "*"`);
		}
		if (pkgJson.dependencies?.[peer] || pkgJson.devDependencies?.[peer]) {
			errors.push(`package.json must not declare ${peer} in dependencies or devDependencies`);
		}
	}
	if (pkgJson.pi?.skills !== undefined) {
		errors.push("package.json must keep pi.skills unset for repository-local skill isolation");
	}

	/* 2. Доменное именование модулей и тестов (без вендорных имён файлов) */
	for (const file of [...walkFiles(join(rootDir, "src")), ...walkFiles(join(rootDir, "tests"))]) {
		const rel = relative(rootDir, file);
		if (/grok/i.test(rel)) {
			errors.push(`${rel}: use neutral domain naming from GLOSSARY.md instead of vendor file names`);
		}
	}

	const toolTypesPath = join(rootDir, "src", "features", "tool-calls", "types.ts");
	if (existsSync(toolTypesPath)) {
		const toolTypesText = readFileSync(toolTypesPath, "utf8");
		const displayStylesMatch = /DISPLAY_STYLES\s*=\s*\[([^\]]+)\]/.exec(toolTypesText);
		if (displayStylesMatch && /["']grok["']/i.test(displayStylesMatch[1])) {
			errors.push("src/features/tool-calls/types.ts: DISPLAY_STYLES must use neutral Tool Density naming");
		}
	}

	/* 3. Запрет однострочных комментариев в новых и изменённых строках TypeScript */
	const addedLinesByFile = parseAddedLinesFromGitDiff(rootDir);
	for (const [relPath, addedLines] of addedLinesByFile.entries()) {
		const absPath = join(rootDir, relPath);
		if (!existsSync(absPath)) continue;
		const commentLines = findSingleLineCommentLines(readFileSync(absPath, "utf8"));
		for (const ln of commentLines) {
			if (addedLines.has(ln)) {
				errors.push(`${relPath}:${ln}: use block comments /* ... */ or /** ... */ instead of single-line //`);
			}
		}
	}

	/* 4. Проверка всех неотслеживаемых новых .ts файлов */
	try {
		const untracked = execFileSync(
			"git",
			["ls-files", "--others", "--exclude-standard", "--", "src", "tests"],
			{ cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		)
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s.endsWith(".ts"));
		for (const relPath of untracked) {
			const absPath = join(rootDir, relPath);
			if (!existsSync(absPath)) continue;
			for (const ln of findSingleLineCommentLines(readFileSync(absPath, "utf8"))) {
				errors.push(`${relPath}:${ln}: use block comments /* ... */ or /** ... */ instead of single-line //`);
			}
		}
	} catch {
		/* git недоступен вне репозитория */
	}

	/* 5. Запрет удалённых фейков хоста, бэкдоров адаптера и ручных TUI-обходов в тестах (ADR-0006) */
	for (const bannedRel of DELETED_FAKE_HARNESS_FILES) {
		if (existsSync(join(rootDir, bannedRel))) {
			errors.push(`${bannedRel}: legacy fake-host harness file must remain deleted (ADR-0006)`);
		}
	}

	for (const file of walkFiles(join(rootDir, "src"))) {
		if (!file.endsWith(".ts")) continue;
		const rel = relative(rootDir, file).replaceAll("\\", "/");
		const rawSrc = readFileSync(file, "utf8");
		const { codeText, moduleSpecifiers, bracketProperties, lineAtOffset } =
			scanTypeScriptCode(rawSrc);
		for (const spec of moduleSpecifiers) {
			if (BANNED_FAKE_MODULE_RE.test(spec.value)) {
				errors.push(`${rel}:${spec.line}: do not import fake-host module "${spec.value}" in src/`);
			}
			if (NODE_FS_SPECIFIER_RE.test(spec.value) && !ALLOWED_FS_SRC_FILES.has(rel)) {
				errors.push(
					`${rel}:${spec.line}: do not import "${spec.value}" in UI render/component modules; route config/disk I/O through edge modules or loadPiUiUserConfig() (ADR-0008)`,
				);
			}
		}
		for (const match of codeText.matchAll(BANNED_SRC_SYMBOL_RE)) {
			errors.push(
				`${rel}:${lineAtOffset(match.index ?? 0)}: do not reintroduce test-adapter backdoor or fake-host symbol "${match[1]}" in src/ (ADR-0006)`,
			);
		}
		for (const match of codeText.matchAll(/\.\s*hasOverlayEntries\b/g)) {
			errors.push(
				`${rel}:${lineAtOffset(match.index ?? 0)}: do not access .hasOverlayEntries; use hasBlockingModalOverlay(tui) from src/shared/modal-card.ts`,
			);
		}
		for (const prop of bracketProperties) {
			if (prop.value === "hasOverlayEntries") {
				errors.push(
					`${rel}:${prop.line}: do not access .hasOverlayEntries; use hasBlockingModalOverlay(tui) from src/shared/modal-card.ts`,
				);
			}
		}
		for (const badLine of findDisallowedCloseGlyphLines(rawSrc)) {
			errors.push(
				`${rel}:${badLine}: use standardized close glyph "×" ("[×]") instead of "✕"`,
			);
		}
	}

	for (const file of walkFiles(join(rootDir, "tests"))) {
		if (!file.endsWith(".ts")) continue;
		const rel = relative(rootDir, file).replaceAll("\\", "/");
		const violations = findTestAntiMockViolations(readFileSync(file, "utf8"), {
			isPureUnit: PURE_UNIT_TEST_FILES.has(rel),
		});
		for (const v of violations) {
			errors.push(`${rel}:${v.line}: ${v.message}`);
		}
	}

	return errors;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const args = process.argv.slice(2);
	const commitMsgIdx = args.indexOf("--commit-msg");
	if (commitMsgIdx !== -1) {
		const msgFile = args[commitMsgIdx + 1];
		if (!msgFile || !existsSync(msgFile)) {
			console.error("Missing commit message file path for --commit-msg");
			process.exit(1);
		}
		const errors = validateCommitMessage(readFileSync(msgFile, "utf8"));
		if (errors.length > 0) {
			for (const err of errors) console.error(`[check-standards] ${err}`);
			process.exit(1);
		}
		process.exit(0);
	}

	const errors = checkRepositoryStandards(ROOT_DIR);
	if (errors.length > 0) {
		for (const err of errors) console.error(`[check-standards] ${err}`);
		process.exit(1);
	}
	process.exit(0);
}
