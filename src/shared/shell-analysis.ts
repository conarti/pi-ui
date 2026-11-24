/**
 * Single-pass shell lexer, parser, and strict `Shell Effect` classifier for bash
 * and PowerShell commands. Powers tool-call summaries, exploration folding, syntax
 * highlighting, and execution safety guards from one shared representation.
 */

export type ShellDialect = "bash" | "powershell";

export type ShellTokenKind =
	| "command"
	| "flag"
	| "number"
	| "string"
	| "variable"
	| "operator"
	| "comment"
	| "whitespace"
	| "plain";

export type ShellToken = {
	readonly kind: ShellTokenKind;
	readonly text: string;
	readonly start: number;
	readonly end: number;
};

export type ShellRedirect = {
	readonly operator: string;
	readonly target: string;
	/** True when this redirection can create or modify a file on disk. */
	readonly writesFile: boolean;
	/** True when this redirection only discards output (/dev/null, $null) or duplicates descriptors (2>&1). */
	readonly harmless: boolean;
};

export type ShellCommand = {
	readonly words: readonly string[];
	readonly redirects: readonly ShellRedirect[];
	readonly raw: string;
	/** Connector that terminated this command, if any (`|`, `&&`, `||`, `;`, `\n`, etc.). */
	readonly connector?: string;
};

export type ShellEffect =
	| { readonly kind: "read-only" }
	| { readonly kind: "mutating"; readonly reason: string };

export type ShellAnalysis = {
	readonly dialect: ShellDialect;
	readonly source: string;
	readonly valid: boolean;
	readonly opaque: boolean;
	readonly opaqueReason?: string;
	readonly commands: readonly ShellCommand[];
	readonly tokens: readonly ShellToken[];
	readonly effect: ShellEffect;
};

const BASH_CONNECTORS = ["&&", "||", "|&", "|", ";"] as const;
const BASH_REDIRECTS = ["<<<", "&>>", "&>", ">>", ">&", ">|", "<>", "<&", ">", "<"] as const;
const PS_CONNECTORS = ["&&", "||", "|", ";"] as const;
const PS_REDIRECTS = ["*>>", "*>&", "*>", ">>", ">&", ">", "<"] as const;

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/gu, "\n");
}

function classifyRedirect(operator: string, target: string, dialect: ShellDialect): ShellRedirect {
	const isDup = /[>&]&$/u.test(operator) || operator.endsWith("<&");
	const dupValid = isDup && /^(?:\d+|-)$/u.test(target);
	const isNullSink = dialect === "powershell"
		? /^(?:\$null|nul)$/iu.test(target)
		: target === "/dev/null";
	const isInputOnly = operator === "<" || operator === "<<<";
	const harmless = dupValid || (!isInputOnly && operator.includes(">") && isNullSink);
	const writesFile = !isInputOnly && !dupValid && !isNullSink;
	return { operator, target, writesFile, harmless };
}

/** Whether a redirection only discards output or joins two streams, rather than reading or writing a file. */
export function isHarmlessRedirect(redirect: ShellRedirect): boolean {
	return redirect.harmless;
}

type MutableCommand = {
	words: string[];
	redirects: ShellRedirect[];
	rawStart: number;
	rawEnd: number;
	connector?: string;
};

export function analyzeShell(rawSource: string, dialect: ShellDialect = "bash"): ShellAnalysis {
	const source = normalizeLineEndings(rawSource);
	const isPowerShell = dialect === "powershell";
	const connectors = isPowerShell ? PS_CONNECTORS : BASH_CONNECTORS;
	const redirects = isPowerShell ? PS_REDIRECTS : BASH_REDIRECTS;

	const tokens: ShellToken[] = [];
	const commands: MutableCommand[] = [{ words: [], redirects: [], rawStart: 0, rawEnd: 0 }];

	let valid = true;
	let invalidReason: string | undefined;
	let opaque = false;
	let opaqueReason: string | undefined;
	let inHeredoc = false;

	let word = "";
	let wordStarted = false;
	let pendingRedirect: string | undefined;
	let commandStart = true;

	const markOpaque = (reason: string) => {
		if (!opaque) {
			opaque = true;
			opaqueReason = reason;
		}
	};

	const markInvalid = (reason: string) => {
		if (valid) {
			valid = false;
			invalidReason = reason;
		}
	};

	const pushToken = (kind: ShellTokenKind, start: number, end: number) => {
		if (end <= start) return;
		tokens.push({ kind, text: source.slice(start, end), start, end });
	};

	const current = () => commands[commands.length - 1]!;

	const flushWord = (endPos: number) => {
		if (!wordStarted) return;
		if (!inHeredoc) {
			if (pendingRedirect !== undefined) {
				current().redirects.push(classifyRedirect(pendingRedirect, word, dialect));
				pendingRedirect = undefined;
			} else {
				current().words.push(word);
			}
			current().rawEnd = endPos;
		}
		word = "";
		wordStarted = false;
	};

	const startWord = (pos: number) => {
		if (!wordStarted && current().words.length === 0 && current().redirects.length === 0 && pendingRedirect === undefined) {
			current().rawStart = pos;
		}
		wordStarted = true;
	};

	const connect = (connector: string, pos: number, nextStart: number) => {
		flushWord(pos);
		if (pendingRedirect !== undefined) {
			markInvalid("incomplete redirection");
			pendingRedirect = undefined;
		}
		if (!inHeredoc && (current().words.length > 0 || current().redirects.length > 0)) {
			current().connector = connector;
			commands.push({ words: [], redirects: [], rawStart: nextStart, rawEnd: nextStart });
		} else {
			current().rawStart = nextStart;
			current().rawEnd = nextStart;
		}
		commandStart = true;
	};

	let index = 0;
	while (index < source.length) {
		const ch = source[index]!;

		// Whitespace (spaces / tabs)
		if (ch === " " || ch === "\t") {
			flushWord(index);
			const start = index;
			while (index < source.length && (source[index] === " " || source[index] === "\t")) index++;
			pushToken("whitespace", start, index);
			continue;
		}

		// Newline
		if (ch === "\n") {
			connect("\n", index, index + 1);
			pushToken("whitespace", index, index + 1);
			index++;
			continue;
		}

		// Comment (only at token boundary)
		if (ch === "#" && !wordStarted) {
			const start = index;
			const end = source.indexOf("\n", index);
			index = end < 0 ? source.length : end;
			pushToken("comment", start, index);
			continue;
		}

		// PowerShell here-string @"..."@ or @'...'@
		if (isPowerShell && ch === "@" && (source[index + 1] === '"' || source[index + 1] === "'")) {
			markOpaque("heredoc");
			markInvalid("heredoc");
			inHeredoc = true;
			const start = index;
			index = source.length;
			pushToken("string", start, index);
			continue;
		}

		// Single-quoted string
		if (ch === "'") {
			const start = index;
			startWord(start);
			index++;
			let closed = false;
			while (index < source.length) {
				if (source[index] === "'") {
					// PowerShell escapes single quote as '' inside single-quoted strings
					if (isPowerShell && source[index + 1] === "'") {
						word += "'";
						index += 2;
						continue;
					}
					index++;
					closed = true;
					break;
				}
				word += source[index]!;
				index++;
			}
			if (!closed) markInvalid("unterminated quote");
			pushToken("string", start, index);
			commandStart = false;
			continue;
		}

		// Double-quoted string
		if (ch === '"') {
			const start = index;
			startWord(start);
			index++;
			let closed = false;
			while (index < source.length) {
				const inner = source[index]!;
				if (inner === '"') {
					index++;
					closed = true;
					break;
				}
				if (isPowerShell) {
					if (inner === "`" && index + 1 < source.length) {
						word += source[index + 1]!;
						index += 2;
						continue;
					}
					if (inner === "$" && source[index + 1] === "(") {
						markOpaque("command substitution");
					}
					word += inner;
					index++;
				} else {
					if (inner === "\\" && index + 1 < source.length && '"\\$`\n'.includes(source[index + 1]!)) {
						if (source[index + 1] !== "\n") word += source[index + 1]!;
						index += 2;
						continue;
					}
					if (inner === "`" || (inner === "$" && source[index + 1] === "(")) {
						markOpaque("command substitution");
					}
					word += inner;
					index++;
				}
			}
			if (!closed) markInvalid("unterminated quote");
			pushToken("string", start, index);
			commandStart = false;
			continue;
		}

		const rest = source.slice(index);

		// Bash heredoc `<<` (but NOT `<<<` here-string)
		if (!isPowerShell && rest.startsWith("<<") && !rest.startsWith("<<<")) {
			flushWord(index);
			markOpaque("heredoc");
			markInvalid("heredoc");
			inHeredoc = true;
			const len = rest.startsWith("<<-") ? 3 : 2;
			pushToken("operator", index, index + len);
			index += len;
			continue;
		}

		// Bash process substitution `<(` or `>(`
		if (!isPowerShell && (ch === "<" || ch === ">") && source[index + 1] === "(") {
			markOpaque("process substitution");
			startWord(index);
			word += ch;
			pushToken("operator", index, index + 2);
			word += "(";
			index += 2;
			commandStart = false;
			continue;
		}

		// Redirection operators
		const redirectOp = redirects.find((op) => rest.startsWith(op));
		if (redirectOp) {
			// A pure-digit word directly preceding the redirection is a file descriptor (e.g. `2>`)
			let descriptor = "";
			if (wordStarted && /^\d+$/u.test(word)) {
				descriptor = word;
				word = "";
				wordStarted = false;
			} else {
				flushWord(index);
			}
			if (pendingRedirect !== undefined) {
				markInvalid("unexpected redirection");
			}
			pendingRedirect = descriptor + redirectOp;
			pushToken("operator", index, index + redirectOp.length);
			index += redirectOp.length;
			continue;
		}

		// Command connectors (`&&`, `||`, `|&`, `|`, `;`)
		const connectorOp = connectors.find((op) => rest.startsWith(op));
		if (connectorOp) {
			connect(connectorOp, index, index + connectorOp.length);
			pushToken("operator", index, index + connectorOp.length);
			index += connectorOp.length;
			continue;
		}

		// Subshell / background / PowerShell call operator `&`, `(`, `)`
		if (ch === "&" || ch === "(" || ch === ")") {
			markOpaque(ch === "&" ? (isPowerShell ? "call operator" : "background execution") : "subshell");
			connect(ch, index, index + 1);
			pushToken("operator", index, index + 1);
			if (ch === ")") commandStart = false;
			index++;
			continue;
		}

		// Unquoted command substitution `$(` or bash backtick
		if (ch === "$" && source[index + 1] === "(") {
			markOpaque("command substitution");
			startWord(index);
			word += "$(";
			pushToken("operator", index, index + 2);
			index += 2;
			commandStart = false;
			continue;
		}
		if (!isPowerShell && ch === "`") {
			markOpaque("command substitution");
			startWord(index);
			word += ch;
			pushToken("operator", index, index + 1);
			index++;
			commandStart = false;
			continue;
		}

		// Variable expansion `$VAR`, `${VAR}`, `$env:PATH`, `$?`, etc.
		if (ch === "$") {
			const match = isPowerShell
				? rest.match(/^\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_:]*(?::[A-Za-z0-9_]+)?|[?$^])/u)
				: rest.match(/^\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])?/u);
			const text = match?.[0] ?? "$";
			startWord(index);
			word += text;
			pushToken("variable", index, index + text.length);
			commandStart = false;
			index += text.length;
			continue;
		}

		// Unquoted word / escape sequence
		const wordStart = index;
		const wasCommandStart = commandStart;
		startWord(wordStart);

		while (index < source.length) {
			const c = source[index]!;
			if (isPowerShell && c === "`") {
				if (index + 1 < source.length) {
					word += source[index + 1]!;
					index += 2;
				} else {
					index++;
				}
				continue;
			}
			if (!isPowerShell && c === "\\") {
				if (index + 1 < source.length) {
					if (source[index + 1] !== "\n") word += source[index + 1]!;
					index += 2;
				} else {
					index++;
				}
				continue;
			}
			if (
				c === " " || c === "\t" || c === "\n"
				|| c === "'" || c === '"' || c === "$"
				|| (!isPowerShell && c === "`")
				|| c === "&" || c === "|" || c === ";"
				|| c === "<" || c === ">" || c === "(" || c === ")"
			) {
				break;
			}
			// PowerShell wildcard redirect `*>`
			if (isPowerShell && c === "*" && source[index + 1] === ">") {
				break;
			}
			word += c;
			index++;
		}

		const rawWord = source.slice(wordStart, index);
		const isAssignment = wasCommandStart && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rawWord);
		const tokenKind: ShellTokenKind =
			pendingRedirect !== undefined
				? (/^\d+$/u.test(rawWord) ? "number" : "plain")
				: wasCommandStart && !isAssignment
					? "command"
					: rawWord.startsWith("-")
						? "flag"
						: /^\d+$/u.test(rawWord)
							? "number"
							: "plain";
		pushToken(tokenKind, wordStart, index);
		if (!isAssignment && pendingRedirect === undefined) {
			commandStart = false;
		}
	}

	flushWord(source.length);
	if (pendingRedirect !== undefined) {
		markInvalid("incomplete redirection");
	}

	const finalCommands: ShellCommand[] = commands
		.filter((cmd) => cmd.words.length > 0 || cmd.redirects.length > 0)
		.map((cmd) => ({
			words: cmd.words,
			redirects: cmd.redirects,
			raw: source.slice(cmd.rawStart, cmd.rawEnd).trim(),
			...(cmd.connector !== undefined ? { connector: cmd.connector } : {}),
		}));

	const effect = computeShellEffect(valid, invalidReason, opaque, opaqueReason, finalCommands, dialect);

	return {
		dialect,
		source,
		valid,
		opaque,
		...(opaqueReason !== undefined ? { opaqueReason } : {}),
		commands: finalCommands,
		tokens,
		effect,
	};
}

export function classifyShellEffect(command: string, dialect: ShellDialect = "bash"): ShellEffect {
	return analyzeShell(command, dialect).effect;
}

const FIND_MUTATING_ACTIONS = new Set([
	"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

const SAFE_BASH_COMMANDS = new Set([
	// File & directory inspection
	"ls", "dir", "cat", "head", "tail", "less", "more", "bat", "batcat", "wc", "file", "stat",
	"readlink", "realpath", "tree", "du", "df", "nl", "strings", "od", "hexdump", "xxd",
	// Search & filtering
	"grep", "egrep", "fgrep", "rg", "ag", "ack", "pt", "find", "fd", "fdfind", "locate",
	"which", "whereis", "type", "diff", "cmp", "comm", "cut", "tr", "uniq", "sort", "jq", "yq",
	"sed", "awk", "gawk", "mawk", "nawk", "rev", "fold", "fmt", "column", "paste", "join",
	"expand", "unexpand", "seq",
	// Checksums & metadata
	"md5", "md5sum", "sha1sum", "sha256sum", "shasum", "cksum",
	// Shell & environment inspection / neutral commands
	"pwd", "echo", "printf", "true", "false", ":", "test", "[", "[[", "basename", "dirname",
	"id", "whoami", "uname", "hostname", "date", "uptime", "env", "printenv", "cd", "pushd",
	"popd", "dirs",
	// Git (further validated by subcommand)
	"git",
]);

const SAFE_POWERSHELL_COMMANDS = new Set([
	// Core read-only inspection cmdlets and common aliases
	"get-content", "gc", "type",
	"get-childitem", "gci", "dir", "ls",
	"select-string", "sls",
	"get-item", "gi", "get-itemproperty", "gp", "test-path",
	"get-location", "gl", "pwd", "resolve-path", "rvpa", "split-path", "join-path",
	"get-process", "gps", "ps", "get-service", "gsv",
	"get-date", "get-host", "get-command", "gcm", "get-help", "get-alias", "gal",
	"get-variable", "gv", "get-filehash", "get-history",
	"where-object", "where", "?", "select-object", "select",
	"sort-object", "sort", "group-object", "group", "measure-object", "measure",
	"format-table", "ft", "format-list", "fl", "format-wide", "fw",
	"out-string", "out-null", "write-output", "write", "echo", "write-host",
	"compare-object", "compare", "diff",
	"convertto-json", "convertfrom-json", "convertto-csv", "convertfrom-csv",
	"set-location", "sl", "cd", "push-location", "pushd", "pop-location", "popd",
]);

const PACKAGE_MANAGERS = new Set([
	"npm", "pnpm", "yarn", "bun", "npx", "pnpx", "pip", "pip3", "uv", "poetry",
	"cargo", "go", "brew", "apt", "apt-get", "yum", "dnf", "pacman", "gem",
	"composer", "dotnet", "nuget", "choco", "winget",
]);

const INTERPRETERS = new Set([
	"node", "deno", "tsx", "ts-node", "python", "python3", "py", "ruby", "perl", "php", "lua", "rscript",
	"sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd",
	"eval", "exec", "source", ".",
]);

function shortFlag(arg: string, letter: string): boolean {
	return /^-[^-]/u.test(arg) && arg.slice(1).includes(letter);
}

function hasOption(args: readonly string[], ...names: string[]): boolean {
	return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function operandCount(args: readonly string[]): number {
	return args.filter((arg) => !arg.startsWith("-") || arg === "-").length;
}

/**
 * sed scripts given with -e, or the first operand when there is none. A short option
 * takes its value from the rest of its word or the next one: `-e'w out'`, `-ne 'w out'`.
 */
function sedScripts(args: readonly string[]): string[] | undefined {
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--expression") scripts.push(args[++index] ?? "");
		else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
		else if (arg === "--file" || arg.startsWith("--file=")) return undefined;
		else if (/^-[^-]/u.test(arg)) {
			for (let position = 1; position < arg.length; position++) {
				const letter = arg[position];
				if (letter === "f") return undefined;
				if (letter !== "e") continue;
				scripts.push(position + 1 < arg.length ? arg.slice(position + 1) : args[++index] ?? "");
				break;
			}
		} else if (!arg.startsWith("-")) operands.push(arg);
	}
	if (scripts.length === 0 && operands[0] !== undefined) scripts.push(operands[0]);
	return scripts;
}

function sedCommandWrites(command: string): boolean {
	const body = command.replace(/^\s*(?:(?:\d+|\$|\/(?:\\.|[^/])*\/)\s*(?:[,~]\s*(?:\d+|\$|\/(?:\\.|[^/])*\/))?\s*!?\s*)?/u, "");
	const verb = body[0];
	if (verb === "w" || verb === "W" || verb === "e") return true;
	if (verb !== "s" || body.length < 2) return false;
	const delimiter = body[1]!;
	let seen = 0;
	let index = 2;
	for (; index < body.length && seen < 2; index++) {
		if (body[index] === "\\") index++;
		else if (body[index] === delimiter) seen++;
	}
	return /^[^;}\s]*[we]/u.test(body.slice(index));
}

function sedWrites(args: readonly string[]): boolean {
	const inPlace = (arg: string) => /^-[^-ef]*i/u.test(arg);
	if (args.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || inPlace(arg))) return true;
	const scripts = sedScripts(args);
	if (!scripts) return true;
	return scripts.some((script) => script.split(/[;\n]/u).some(sedCommandWrites));
}

function awkWrites(args: readonly string[]): boolean {
	let program: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "-f" || arg.startsWith("--file") || arg === "-i" || arg.startsWith("--include")) return true;
		if (arg === "-v" || arg === "-F") index++;
		else if (!arg.startsWith("-")) {
			program = arg;
			break;
		}
	}
	return program === undefined || /system\s*\(|[|>]/u.test(program);
}

const SAFE_GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const SAFE_GIT_GLOBAL_FLAGS = new Set([
	"--no-pager", "-P", "--bare", "--literal-pathspecs", "--glob-pathspecs",
	"--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks",
	"--version", "-v", "--help", "-h",
]);
const ALWAYS_READONLY_GIT_SUBCOMMANDS = new Set([
	"status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree",
	"grep", "describe", "shortlog", "blame", "cat-file", "for-each-ref",
	"rev-list", "merge-base", "name-rev", "show-ref", "version", "help",
]);

function classifyGitEffect(args: readonly string[]): ShellEffect {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (!arg.startsWith("-")) break;
		if (SAFE_GIT_GLOBAL_VALUE_FLAGS.has(arg)) {
			index += 2;
			continue;
		}
		if (SAFE_GIT_GLOBAL_FLAGS.has(arg)
			|| arg.startsWith("--git-dir=")
			|| arg.startsWith("--work-tree=")
			|| arg.startsWith("--namespace=")) {
			index++;
			continue;
		}
		return { kind: "mutating", reason: `mutating or unsafe git global option: ${arg}` };
	}

	const sub = args[index];
	if (!sub) return { kind: "read-only" };
	const rest = args.slice(index + 1);

	if (ALWAYS_READONLY_GIT_SUBCOMMANDS.has(sub)) {
		if (sub === "grep" && (rest.some((arg) => /^-[^-]*O/u.test(arg)) || hasOption(rest, "--open-files-in-pager"))) {
			return { kind: "mutating", reason: "git grep opens pager" };
		}
		if ((sub === "diff" || sub === "log" || sub === "show") && hasOption(rest, "--output")) {
			return { kind: "mutating", reason: `git ${sub} --output writes a file` };
		}
		return { kind: "read-only" };
	}

	if (sub === "branch") {
		const mutatingFlags = new Set([
			"-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy",
			"-f", "--force", "-u", "--set-upstream-to", "--unset-upstream",
			"--edit-description", "--track", "--no-track", "--create-reflog", "-t",
		]);
		const valueFlags = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--abbrev", "--column"]);
		let hasListFlag = false;
		let positionalCount = 0;
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			if (mutatingFlags.has(arg) || arg.startsWith("--set-upstream-to=")) {
				return { kind: "mutating", reason: `mutating git branch flag: ${arg}` };
			}
			if (arg === "-l" || arg === "--list" || arg === "--show-current") {
				hasListFlag = true;
				continue;
			}
			if (valueFlags.has(arg)) {
				i++;
				continue;
			}
			if (/^-[^-]/u.test(arg) && /[dDmMcCfut]/u.test(arg.slice(1))) {
				return { kind: "mutating", reason: `mutating git branch flag: ${arg}` };
			}
			if (!arg.startsWith("-")) positionalCount++;
		}
		if (positionalCount > 0 && !hasListFlag) {
			return { kind: "mutating", reason: "git branch creates a branch" };
		}
		return { kind: "read-only" };
	}

	if (sub === "tag") {
		const mutatingFlags = new Set([
			"-a", "-s", "-u", "-d", "-f", "-m", "-F",
			"--annotate", "--sign", "--local-user", "--delete", "--force",
			"--message", "--file", "--cleanup", "--create-reflog",
		]);
		const valueFlags = new Set(["-n", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
		let hasListFlag = false;
		let positionalCount = 0;
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			if (mutatingFlags.has(arg) || arg.startsWith("--message=") || arg.startsWith("--file=")) {
				return { kind: "mutating", reason: `mutating git tag flag: ${arg}` };
			}
			if (arg === "-l" || arg === "--list" || arg === "-v" || arg === "--verify") {
				hasListFlag = true;
				continue;
			}
			if (valueFlags.has(arg)) {
				i++;
				continue;
			}
			if (/^-[^-]/u.test(arg) && /[asudfmF]/u.test(arg.slice(1))) {
				return { kind: "mutating", reason: `mutating git tag flag: ${arg}` };
			}
			if (!arg.startsWith("-")) positionalCount++;
		}
		if (positionalCount > 0 && !hasListFlag) {
			return { kind: "mutating", reason: "git tag creates a tag" };
		}
		return { kind: "read-only" };
	}

	if (sub === "remote") {
		const nonFlags = rest.filter((arg) => !arg.startsWith("-"));
		if (nonFlags.length === 0 || nonFlags[0] === "show" || nonFlags[0] === "get-url") {
			return { kind: "read-only" };
		}
		return { kind: "mutating", reason: `mutating git remote action: ${nonFlags[0]}` };
	}

	if (sub === "config") {
		const mutatingFlags = ["--unset", "--unset-all", "--add", "--replace-all", "--remove-section", "--rename-section", "-e", "--edit"];
		const readFlags = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"];
		if (hasOption(rest, ...mutatingFlags)) {
			return { kind: "mutating", reason: "mutating git config flag" };
		}
		if (hasOption(rest, ...readFlags)) {
			return { kind: "read-only" };
		}
		return { kind: "mutating", reason: "git config without explicit read flag" };
	}

	if (sub === "stash") {
		const action = rest.find((arg) => !arg.startsWith("-"));
		if (action === "list" || action === "show") return { kind: "read-only" };
		return { kind: "mutating", reason: `mutating git stash action: ${action ?? "push"}` };
	}

	return { kind: "mutating", reason: `mutating git subcommand: ${sub}` };
}

/**
 * Whether a command can change files or run another program, even when the base
 * utility normally only reads: `find -delete`, `fd -x`, `rg --pre`, `sort -o`,
 * in-place or writing `sed`, file-writing `awk`, `yq -i`, `xargs`, `tee`, etc.
 */
export function writesOrRuns(words: readonly string[], dialect: ShellDialect = "bash"): boolean {
	const rawProgram = words[0];
	if (!rawProgram) return false;
	const program = dialect === "powershell" ? rawProgram.toLowerCase() : rawProgram;
	const args = words.slice(1);
	switch (program) {
		case "git":
			return classifyGitEffect(args).kind === "mutating";
		case "ag": case "ack": case "pt": case "bat": case "batcat":
			return hasOption(args, "--pager");
		case "xargs": case "tee":
			return true;
		case "find":
			return args.some((arg) => FIND_MUTATING_ACTIONS.has(arg));
		case "fd": case "fdfind":
			return args.some((arg) => arg === "-x" || arg === "-X" || /^--exec(?:-batch)?(?:=|$)/u.test(arg));
		case "rg":
			return hasOption(args, "--pre", "--hostname-bin");
		case "sort":
			return args.some((arg) => arg.startsWith("--output") || arg.startsWith("--compress-program") || shortFlag(arg, "o"));
		case "uniq":
			return operandCount(args) >= 2;
		case "tree":
			return args.some((arg) => arg === "-o" || arg.startsWith("--output"));
		case "sed":
			return sedWrites(args);
		case "awk": case "gawk": case "mawk": case "nawk":
			return awkWrites(args);
		case "yq":
			return args.some((arg) => arg === "--inplace" || shortFlag(arg, "i"));
		default:
			return false;
	}
}

function normalizeExecutableName(raw: string, dialect: ShellDialect): { name: string; untrustedPath: boolean } {
	if (raw.includes("/") || raw.includes("\\")) {
		const isTrustedSystemPath = /^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?bin\/[^/]+$/u.test(raw);
		if (!isTrustedSystemPath) {
			return { name: raw, untrustedPath: true };
		}
		const base = raw.slice(raw.lastIndexOf("/") + 1);
		return { name: dialect === "powershell" ? base.replace(/\.exe$/iu, "").toLowerCase() : base, untrustedPath: false };
	}
	if (dialect === "powershell") {
		if (/\.(?:ps1|bat|cmd|vbs|js|sh)$/iu.test(raw)) {
			return { name: raw.toLowerCase(), untrustedPath: true };
		}
		return { name: raw.replace(/\.exe$/iu, "").toLowerCase(), untrustedPath: false };
	}
	return { name: raw, untrustedPath: false };
}

export interface UnwrapCommandOptions {
	/** Also strip `sudo` when deriving human-readable summaries (security classification keeps `sudo` intact). */
	unwrapSudo?: boolean;
}

export type UnwrappedCommandResult =
	| { kind: "empty" }
	| { kind: "builtin-query" }
	| { kind: "unsupported-wrapper-flag"; wrapper: string; flag: string }
	| { kind: "command"; words: string[] };

/**
 * Strips leading environment variable assignments (`FOO=1`) and wrapper commands
 * (`env`, `command`, `time`, and optionally `sudo`) to expose the underlying command words.
 */
export function unwrapCommandWords(
	words: readonly string[],
	options?: UnwrapCommandOptions,
): UnwrappedCommandResult {
	let current: readonly string[] = words;
	while (true) {
		let start = 0;
		while (start < current.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(current[start]!)) {
			start++;
		}
		if (start >= current.length) return { kind: "empty" };

		const slice = current.slice(start);
		const first = options?.unwrapSudo ? slice[0]!.toLowerCase() : slice[0]!;

		if (first === "env") {
			let idx = 1;
			while (idx < slice.length) {
				const arg = slice[idx]!;
				if (arg === "-u" || arg === "--unset") {
					idx += 2;
					continue;
				}
				if (arg === "-i" || arg === "--ignore-environment" || arg === "-0" || arg === "--null"
					|| arg.startsWith("--unset=") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) {
					idx++;
					continue;
				}
				if (arg === "--") {
					idx++;
					break;
				}
				break;
			}
			if (idx >= slice.length) return { kind: "empty" };
			current = slice.slice(idx);
			continue;
		}

		if (first === "command") {
			let idx = 1;
			while (idx < slice.length && slice[idx]!.startsWith("-")) {
				const arg = slice[idx]!;
				if (arg === "-v" || arg === "-V") return { kind: "builtin-query" };
				if (arg === "--") {
					idx++;
					break;
				}
				if (arg !== "-p") return { kind: "unsupported-wrapper-flag", wrapper: "command", flag: arg };
				idx++;
			}
			if (idx >= slice.length) return { kind: "empty" };
			current = slice.slice(idx);
			continue;
		}

		if (first === "time") {
			let idx = 1;
			while (idx < slice.length && (slice[idx] === "-p" || slice[idx] === "--")) idx++;
			if (idx >= slice.length) return { kind: "empty" };
			current = slice.slice(idx);
			continue;
		}

		if (options?.unwrapSudo && first === "sudo") {
			let idx = 1;
			while (idx < slice.length && slice[idx]!.startsWith("-")) {
				const arg = slice[idx]!;
				if (arg === "--") {
					idx++;
					break;
				}
				idx++;
			}
			if (idx >= slice.length) return { kind: "empty" };
			current = slice.slice(idx);
			continue;
		}

		return { kind: "command", words: [...slice] };
	}
}

function classifySingleCommand(words: readonly string[], dialect: ShellDialect): ShellEffect {
	const unwrapped = unwrapCommandWords(words);
	if (unwrapped.kind === "empty" || unwrapped.kind === "builtin-query") {
		return { kind: "read-only" };
	}
	if (unwrapped.kind === "unsupported-wrapper-flag") {
		return { kind: "mutating", reason: `unsupported ${unwrapped.wrapper} flag: ${unwrapped.flag}` };
	}

	const slice = unwrapped.words;
	const first = slice[0]!;

	const { name, untrustedPath } = normalizeExecutableName(first, dialect);
	if (untrustedPath) {
		return { kind: "mutating", reason: `script or path invocation: ${first}` };
	}

	const lowerName = name.toLowerCase();
	if (INTERPRETERS.has(lowerName)) {
		return { kind: "mutating", reason: `interpreter invocation: ${name}` };
	}
	if (PACKAGE_MANAGERS.has(lowerName)) {
		return { kind: "mutating", reason: `package manager command: ${name}` };
	}

	if (lowerName === "git") {
		return classifyGitEffect(slice.slice(1));
	}

	const isAllowed = dialect === "powershell"
		? SAFE_POWERSHELL_COMMANDS.has(lowerName) || SAFE_BASH_COMMANDS.has(lowerName)
		: SAFE_BASH_COMMANDS.has(name);

	if (!isAllowed) {
		return { kind: "mutating", reason: `command not in read-only allowlist: ${first}` };
	}

	if (writesOrRuns([name, ...slice.slice(1)], dialect)) {
		return { kind: "mutating", reason: `mutating flag or action on ${name}` };
	}

	return { kind: "read-only" };
}

function computeShellEffect(
	valid: boolean,
	invalidReason: string | undefined,
	opaque: boolean,
	opaqueReason: string | undefined,
	commands: readonly ShellCommand[],
	dialect: ShellDialect,
): ShellEffect {
	if (!valid) return { kind: "mutating", reason: invalidReason ?? "invalid shell syntax" };
	if (opaque) return { kind: "mutating", reason: opaqueReason ?? "opaque shell construct" };

	for (const command of commands) {
		for (const redirect of command.redirects) {
			if (redirect.writesFile) {
				return { kind: "mutating", reason: `file redirection: ${redirect.operator} ${redirect.target}` };
			}
		}
		const effect = classifySingleCommand(command.words, dialect);
		if (effect.kind === "mutating") return effect;
	}

	return { kind: "read-only" };
}
