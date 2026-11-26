import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

export type InspectableLinkTarget =
	| {
			readonly kind: "url";
			readonly url: string;
			readonly displayTarget: string;
			readonly copyText: string;
			readonly label?: string;
	  }
	| {
			readonly kind: "path";
			readonly rawPath: string;
			readonly resolvedPath: string;
			readonly line?: number;
			readonly column?: number;
			readonly displayTarget: string;
			readonly copyText: string;
			readonly label?: string;
	  };

export interface LinkTargetResolveOptions {
	readonly cwd?: string;
	readonly checkExists?: (filePath: string) => boolean;
}

export interface FilePathSpan {
	readonly xStart: number;
	readonly xEnd: number;
	readonly target: Extract<InspectableLinkTarget, { kind: "path" }>;
}

const KNOWN_EXTENSIONLESS_FILES = new Set([
	"Makefile",
	"Dockerfile",
	"Containerfile",
	"Jenkinsfile",
	"Podfile",
	"Gemfile",
	"Rakefile",
	"Vagrantfile",
	"Procfile",
	"Brewfile",
	"LICENSE",
	"README",
	"CHANGELOG",
	"AUTHORS",
	"NOTICE",
]);

const KNOWN_FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const URL_SCHEME_RE = /^(?:https?|mailto|ftp|data|javascript):/i;
const TRAILING_PUNCT_RE = /[.,;!?)\]}'"]+$/;
const LEADING_WRAP_RE = /^[`'"([{<]+/;
const TRAILING_WRAP_RE = /[`'"\])}>.,;!?]+$/;
const LINE_COL_SUFFIX_RE = /^(.*?):(\d{1,7})(?::(\d{1,6}))?$/;
const HASH_LINE_SUFFIX_RE = /^(.*?)#L(\d{1,7})(?:C(\d{1,6}))?(?:-L\d+)?$/i;

function resolveLocalFilePath(rawPath: string, cwd: string): string {
	if (rawPath.startsWith("~/")) {
		return resolve(homedir(), rawPath.slice(2));
	}
	return resolve(cwd, rawPath);
}

function formatVerbatimPathTarget(rawPath: string, line?: number, column?: number): string {
	if (line === undefined) return rawPath;
	return column !== undefined ? `${rawPath}:${line}:${column}` : `${rawPath}:${line}`;
}

export function parseFilePathReference(
	rawToken: string,
	options?: LinkTargetResolveOptions,
): Extract<InspectableLinkTarget, { kind: "path" }> | undefined {
	let cleaned = rawToken.trim().replace(LEADING_WRAP_RE, "").replace(TRAILING_WRAP_RE, "");
	if (!cleaned || cleaned.length > 512) return undefined;
	if (URL_SCHEME_RE.test(cleaned)) return undefined;

	if (cleaned.toLowerCase().startsWith("file://")) {
		try {
			const parsed = new URL(cleaned);
			let pathname = decodeURIComponent(parsed.pathname);
			if (/^\/[A-Za-z]:\//.test(pathname)) {
				pathname = pathname.slice(1);
			}
			const hashMatch = /^#L(\d{1,7})(?:C(\d{1,6}))?(?:-L\d+)?$/i.exec(parsed.hash);
			const line = hashMatch ? Number.parseInt(hashMatch[1]!, 10) : undefined;
			const column = hashMatch?.[2] ? Number.parseInt(hashMatch[2], 10) : undefined;
			const copyText = formatVerbatimPathTarget(pathname, line, column);
			return {
				kind: "path",
				rawPath: pathname,
				resolvedPath: pathname,
				line,
				column,
				displayTarget: copyText,
				copyText,
			};
		} catch {
			return undefined;
		}
	}

	let pathPart = cleaned;
	let line: number | undefined;
	let column: number | undefined;

	const hashMatch = HASH_LINE_SUFFIX_RE.exec(pathPart);
	if (hashMatch && hashMatch[1]) {
		pathPart = hashMatch[1];
		line = Number.parseInt(hashMatch[2]!, 10);
		if (hashMatch[3]) column = Number.parseInt(hashMatch[3], 10);
	} else {
		const colonMatch = LINE_COL_SUFFIX_RE.exec(pathPart);
		if (colonMatch && colonMatch[1] && !/^\d+$/.test(colonMatch[1])) {
			pathPart = colonMatch[1];
			line = Number.parseInt(colonMatch[2]!, 10);
			if (colonMatch[3]) column = Number.parseInt(colonMatch[3], 10);
		}
	}

	pathPart = pathPart.replace(TRAILING_PUNCT_RE, "");
	if (!pathPart || pathPart === "/" || pathPart === "." || pathPart === "..") return undefined;
	if (/\s/.test(pathPart) || pathPart.includes("://")) return undefined;

	const cwd = options?.cwd ?? process.cwd();
	const checkExists = options?.checkExists ?? existsSync;
	const resolvedPath = resolveLocalFilePath(pathPart, cwd);
	const fileName = basename(pathPart);
	const hasSlash = pathPart.includes("/");
	const hasExt = KNOWN_FILE_EXT_RE.test(fileName);
	const isKnownExtensionless = KNOWN_EXTENSIONLESS_FILES.has(fileName);

	let exists = false;
	try {
		exists = checkExists(resolvedPath);
	} catch {
		exists = false;
	}

	const looksLikePath =
		exists ||
		(hasSlash && (hasExt || isKnownExtensionless) && !/^\/?\d+\/\d+$/.test(pathPart)) ||
		(line !== undefined && (hasExt || isKnownExtensionless));

	if (!looksLikePath) return undefined;

	const copyText = formatVerbatimPathTarget(pathPart, line, column);
	return {
		kind: "path",
		rawPath: pathPart,
		resolvedPath,
		line,
		column,
		displayTarget: copyText,
		copyText,
	};
}

export function classifyMarkdownLinkTarget(
	href: string,
	labelText: string,
	options?: LinkTargetResolveOptions,
): InspectableLinkTarget | undefined {
	const trimmedHref = href.trim();
	if (!trimmedHref) return undefined;
	const lower = trimmedHref.toLowerCase();

	if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
		const normalizedHref = lower.startsWith("mailto:") ? trimmedHref.slice(7) : trimmedHref;
		const trimmedLabel = labelText.trim();
		/* Обычный автолинк, где URL уже напечатан текстом, не является скрытой ссылкой [text](url) */
		if (trimmedLabel && (trimmedLabel === trimmedHref || trimmedLabel === normalizedHref)) {
			return undefined;
		}
		return {
			kind: "url",
			url: trimmedHref,
			displayTarget: trimmedHref,
			copyText: trimmedHref,
			label: trimmedLabel || undefined,
		};
	}

	const parsedPath = parseFilePathReference(trimmedHref, options);
	if (parsedPath) {
		return {
			...parsedPath,
			label: labelText.trim() || undefined,
		};
	}

	return undefined;
}

const CANDIDATE_TOKEN_RE = /[^\s`'"()[\]{}<>]+/g;

export function findFilePathSpansInLine(
	plainLine: string,
	options?: LinkTargetResolveOptions,
): FilePathSpan[] {
	if (!plainLine) return [];

	const spans: FilePathSpan[] = [];
	CANDIDATE_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CANDIDATE_TOKEN_RE.exec(plainLine)) !== null) {
		const raw = match[0];
		const trimmed = raw.replace(TRAILING_PUNCT_RE, "");
		if (!trimmed) continue;
		const target = parseFilePathReference(trimmed, options);
		if (!target) continue;

		const xStart = visibleWidth(plainLine.slice(0, match.index));
		const xEnd = xStart + visibleWidth(trimmed);
		if (xEnd > xStart) {
			spans.push({ xStart, xEnd, target });
		}
	}

	return spans;
}

const GOTO_FLAG_EDITORS = new Set(["code", "code-insiders", "cursor", "windsurf", "codium"]);
const COLON_LINE_EDITORS = new Set(["zed", "subl", "sublime", "hx", "helix", "goland", "webstorm", "idea"]);
const PLUS_LINE_EDITORS = new Set(["vim", "nvim", "vi", "nano", "micro", "emacs", "emacsclient", "joe", "kate"]);

export function buildEditorOpenCommand(
	editorEnv: string | undefined,
	filePath: string,
	options?: { readonly line?: number; readonly column?: number },
): { readonly command: string; readonly args: string[] } | undefined {
	const raw = editorEnv?.trim();
	if (!raw) return undefined;

	const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((tok) =>
		tok.replace(/^["']|["']$/g, ""),
	);
	if (!tokens || tokens.length === 0) return undefined;

	const command = tokens[0]!;
	const presetArgs = tokens.slice(1);
	const exeName = basename(command).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
	const line = options?.line !== undefined && options.line > 0 ? Math.floor(options.line) : undefined;
	const column =
		options?.column !== undefined && options.column > 0 ? Math.floor(options.column) : undefined;

	if (line !== undefined) {
		const loc = column !== undefined ? `${filePath}:${line}:${column}` : `${filePath}:${line}`;
		if (GOTO_FLAG_EDITORS.has(exeName)) {
			return { command, args: [...presetArgs, "-g", loc] };
		}
		if (COLON_LINE_EDITORS.has(exeName)) {
			return { command, args: [...presetArgs, loc] };
		}
		if (PLUS_LINE_EDITORS.has(exeName)) {
			return { command, args: [...presetArgs, `+${line}`, filePath] };
		}
	}

	return { command, args: [...presetArgs, filePath] };
}
