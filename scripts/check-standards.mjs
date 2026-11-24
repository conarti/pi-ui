import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PEER_PACKAGES } from "./resolve-host-pi.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BANNED_COMMIT_PATTERNS = [
	{ label: "Co-Authored-By trailer", regex: /^Co-Authored-By:/im },
	{ label: "Generated-with/by phrase", regex: /\bGenerated\s+(?:with|by)\b/i },
	{ label: "em-dash or en-dash", regex: /[\u2013\u2014]/ },
	{ label: "double hyphen in prose", regex: /(?:^|\s)--(?:\s|$)/m },
];

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
			{ cwd: rootDir, encoding: "utf8" },
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
			{ cwd: rootDir, encoding: "utf8" },
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
