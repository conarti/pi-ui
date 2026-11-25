import { describe, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { analyzeShell, classifyShellEffect } from "../src/shared/shell-analysis.ts";
import { classifyShellCommand, lookKind } from "../src/features/tool-calls/claude.ts";
import { exploreActions, parseExploreCommand } from "../src/features/tool-calls/codex.ts";
import { highlightCommand } from "../src/features/tool-calls/codex-rows.ts";
import { shellSegments, summarizeShellCommand } from "../src/features/tool-calls/invocation.ts";
import { loadPackageThemes } from "./harness/index.ts";

describe("Shell Analysis — parsing, segments, and syntax token spans", () => {
	it("splits bash pipelines and lists while preserving quoted operators and escapes", () => {
		const analysis = analyzeShell(`grep -n "a > b | c" 'foo;bar' && wc -l < input.txt | head -n 5`);
		expect(analysis.valid).toBe(true);
		expect(analysis.opaque).toBe(false);
		expect(analysis.commands).toHaveLength(3);
		expect(analysis.commands[0]!.words).toEqual(["grep", "-n", "a > b | c", "foo;bar"]);
		expect(analysis.commands[0]!.redirects).toEqual([]);
		expect(analysis.commands[1]!.words).toEqual(["wc", "-l"]);
		expect(analysis.commands[1]!.redirects).toEqual([
			{ operator: "<", target: "input.txt", writesFile: false, harmless: false },
		]);
		expect(analysis.commands[2]!.words).toEqual(["head", "-n", "5"]);
	});

	it("parses file and descriptor redirections accurately", () => {
		const analysis = analyzeShell("rg foo src 2>&1 1>/dev/null && cat a.txt >> out.log");
		expect(analysis.valid).toBe(true);
		expect(analysis.commands[0]!.redirects).toEqual([
			{ operator: "2>&", target: "1", writesFile: false, harmless: true },
			{ operator: "1>", target: "/dev/null", writesFile: false, harmless: true },
		]);
		expect(analysis.commands[1]!.redirects).toEqual([
			{ operator: ">>", target: "out.log", writesFile: true, harmless: false },
		]);
	});

	it("flags opaque constructs (command substitution, backticks, process substitution, subshell, heredoc, background)", () => {
		for (const cmd of [
			"echo $(whoami)",
			'echo "hi $(id)"',
			"echo `pwd`",
			"diff <(ls a) <(ls b)",
			"cat >(tee out.txt)",
			"(cd src && ls)",
			"sleep 1 &",
			"cat <<EOF\nhello\nEOF",
		]) {
			const analysis = analyzeShell(cmd);
			expect(analysis.opaque, cmd).toBe(true);
		}
	});

	it("marks unterminated quotes as invalid while still returning complete syntax token spans", () => {
		const source = `rg "unterminated`;
		const analysis = analyzeShell(source);
		expect(analysis.valid).toBe(false);
		expect(analysis.tokens.map((t) => t.text).join("")).toBe(source);
		expect(analysis.tokens.some((t) => t.kind === "command" && t.text === "rg")).toBe(true);
		expect(analysis.tokens.some((t) => t.kind === "string" && t.text === `"unterminated`)).toBe(true);
	});

	it("produces lossless syntax token spans covering commands, flags, numbers, strings, variables, operators, and comments", () => {
		const source = `FOO=1 rg --max-count 10 "hello" $HOME | head -n 5 # comment`;
		const analysis = analyzeShell(source);
		expect(analysis.tokens.map((t) => t.text).join("")).toBe(source);
		for (const token of analysis.tokens) {
			expect(source.slice(token.start, token.end)).toBe(token.text);
		}
		expect(analysis.tokens.filter((t) => t.kind !== "whitespace").map((t) => [t.kind, t.text])).toEqual([
			["plain", "FOO=1"],
			["command", "rg"],
			["flag", "--max-count"],
			["number", "10"],
			["string", '"hello"'],
			["variable", "$HOME"],
			["operator", "|"],
			["command", "head"],
			["flag", "-n"],
			["number", "5"],
			["comment", "# comment"],
		]);
	});

	it("parses PowerShell backtick escapes, $null sinks, and subexpressions", () => {
		const safe = analyzeShell('Get-Content -Path "a > `"b`".txt" 2>$null | Select-String -Pattern \'foo\'', "powershell");
		expect(safe.valid).toBe(true);
		expect(safe.opaque).toBe(false);
		expect(safe.commands).toHaveLength(2);
		expect(safe.commands[0]!.words).toEqual(["Get-Content", "-Path", 'a > "b".txt']);
		expect(safe.commands[0]!.redirects).toEqual([
			{ operator: "2>", target: "$null", writesFile: false, harmless: true },
		]);
		expect(safe.commands[1]!.words).toEqual(["Select-String", "-Pattern", "foo"]);

		const unquotedEscape = analyzeShell("Get-Content a` b.txt", "powershell");
		expect(unquotedEscape.valid).toBe(true);
		expect(unquotedEscape.opaque).toBe(false);
		expect(unquotedEscape.commands[0]!.words).toEqual(["Get-Content", "a b.txt"]);

		const opaque = analyzeShell('Write-Output "$(Get-Date)"', "powershell");
		expect(opaque.opaque).toBe(true);
	});
});

describe("Shell Effect — strict read-only vs potentially mutating classification", () => {
	it("classifies pure inspection commands and quoted redirection operators as read-only", () => {
		const readOnlyCommands = [
			"ls -la src",
			"cat README.md | head -n 20",
			"rg 'foo > bar' src 2>/dev/null",
			'grep "a >> b | c" src/index.ts 2>&1',
			"find src -name '*.ts' -type f",
			"fd -e ts src",
			"wc -l < package.json",
			"stat package.json && file README.md",
			"sed -n '1,20p' package.json",
			"awk '{print $1}' README.md | sort -u | uniq",
			"jq '.name' package.json",
			"diff -u a.txt b.txt",
			"pwd && which node && command -v git",
			"env FOO=bar rg pattern src",
			"time ls src",
			"cat <<< 'hello world'",
			"   # comment only",
		];
		for (const cmd of readOnlyCommands) {
			expect(classifyShellEffect(cmd), cmd).toEqual({ kind: "read-only" });
		}
	});

	it("classifies read-only git inspection subcommands as read-only and mutating git commands as mutating", () => {
		const readOnlyGit = [
			"git status",
			"git status --short",
			"git diff HEAD~1",
			"git log --oneline -n 10",
			"git show HEAD:package.json",
			"git branch",
			"git branch -a",
			"git branch -v --list 'feat/*'",
			"git branch --show-current",
			"git rev-parse --show-toplevel",
			"git ls-files src",
			"git grep -n ShellEffect",
			"git describe --tags --always",
			"git shortlog -sn",
			"git blame src/index.ts",
			"git cat-file -p HEAD",
			"git ls-tree HEAD",
			"git for-each-ref",
			"git tag",
			"git tag -l 'v*'",
			"git remote -v",
			"git remote show origin",
			"git config --get user.name",
			"git config --list",
			"git stash list",
			"git stash show",
			"git -C /tmp/repo --no-pager status",
		];
		for (const cmd of readOnlyGit) {
			expect(classifyShellEffect(cmd), cmd).toEqual({ kind: "read-only" });
		}

		const mutatingGit = [
			"git commit -m 'msg'",
			"git push origin main",
			"git pull",
			"git checkout main",
			"git switch -c feat",
			"git reset --hard HEAD",
			"git clean -fd",
			"git branch new-branch",
			"git branch -d old-branch",
			"git branch -D old-branch",
			"git branch -m a b",
			"git tag v1.0.0",
			"git tag -d v1.0.0",
			"git remote add origin https://example.com/repo.git",
			"git config user.name 'Bob'",
			"git config --unset user.name",
			"git stash pop",
			"git stash",
			"git -c core.pager=sh log",
			"git grep -O pattern",
			"git diff --output=patch.diff",
		];
		for (const cmd of mutatingGit) {
			const effect = classifyShellEffect(cmd);
			expect(effect.kind, cmd).toBe("mutating");
		}
	});

	it("classifies file-writing redirections and opaque constructs as mutating", () => {
		const mutating = [
			"echo hi > out.txt",
			"cat a.txt >> b.txt",
			"ls src &> listing.txt",
			"rg foo src 2> errors.log",
			"cat <> file.txt",
			"echo $(rm -rf /tmp/x)",
			'echo "hi `whoami`"',
			"diff <(ls a) <(ls b)",
			"(ls src)",
			"ls src &",
			"cat <<EOF\nhello\nEOF",
			'echo "unterminated',
		];
		for (const cmd of mutating) {
			const effect = classifyShellEffect(cmd);
			expect(effect.kind, cmd).toBe("mutating");
		}
	});

	it("classifies mutating flags on read utilities as mutating", () => {
		const mutating = [
			"find . -name '*.tmp' -delete",
			"find . -exec rm {} +",
			"find . -execdir rm {} \\;",
			"find . -ok rm {} \\;",
			"find . -fprint out.txt",
			"fd -x rm",
			"fd --exec-batch rm",
			"rg --pre ./filter.sh foo",
			"rg --hostname-bin ./evil foo",
			"sed -i 's/a/b/' file.txt",
			"sed --in-place 's/a/b/' file.txt",
			"sed -ne 'w out.txt' file.txt",
			"sed 's/a/b/w out.txt' file.txt",
			"sed '1e id' file.txt",
			"sed -f script.sed file.txt",
			"awk '{system(\"id\")}' file.txt",
			"awk '{print > \"out.txt\"}' file.txt",
			"awk '{print | \"sh\"}' file.txt",
			"awk -f script.awk file.txt",
			"sort -o out.txt in.txt",
			"sort --output=out.txt in.txt",
			"uniq in.txt out.txt",
			"tree -o out.txt",
			"bat --pager=sh file.txt",
			"yq -i '.a = 1' file.yaml",
			"ls | xargs rm",
			"ls | tee out.txt",
		];
		for (const cmd of mutating) {
			const effect = classifyShellEffect(cmd);
			expect(effect.kind, cmd).toBe("mutating");
		}
	});

	it("classifies package manager commands and inline code/shell interpreters as mutating", () => {
		const mutating = [
			"npm install lodash",
			"npm run build",
			"pnpm add vitest",
			"yarn remove foo",
			"bun test",
			"npx tsc",
			"pip install requests",
			"uv add ruff",
			"cargo test",
			"go run main.go",
			"brew install jq",
			"node -e 'console.log(1)'",
			"python -c 'print(1)'",
			"python3 -c 'import os'",
			"ruby -e 'puts 1'",
			"perl -e 'print 1'",
			"sh -c 'ls'",
			"bash -c 'ls'",
			"zsh -c 'ls'",
			"dash -c 'ls'",
			"fish -c 'ls'",
			"pwsh -Command 'Get-Location'",
			"powershell -EncodedCommand ZQBjAGgAbwA=",
			"eval 'ls'",
			"source ./env.sh",
			"./deploy.sh",
			"sudo ls",
			"rm -rf dist",
			"mv a.txt b.txt",
			"cp a.txt b.txt",
			"touch new.txt",
		];
		for (const cmd of mutating) {
			const effect = classifyShellEffect(cmd);
			expect(effect.kind, cmd).toBe("mutating");
		}
	});

	it("classifies PowerShell read-only inspection cmdlets vs mutating cmdlets and redirections", () => {
		const readOnlyPs = [
			"Get-Content README.md",
			"Get-ChildItem -Path src -Recurse",
			"Select-String -Pattern 'a > b' -Path src/*.ts",
			"Get-Item package.json",
			"Test-Path src/index.ts",
			"Get-Location",
			"Get-Process | Where-Object Name -eq 'node' | Select-Object Id, Name",
			"Get-Service | Measure-Object",
			"Get-ChildItem | Format-Table | Out-String",
			"Get-Content README.md 2>$null",
			"git status",
		];
		for (const cmd of readOnlyPs) {
			expect(classifyShellEffect(cmd, "powershell"), cmd).toEqual({ kind: "read-only" });
		}

		const mutatingPs = [
			"Get-Content README.md > copy.md",
			"Get-ChildItem >> list.txt",
			"Get-Content README.md | Out-File copy.md",
			"Set-Content -Path a.txt -Value 'hi'",
			"Add-Content -Path a.txt -Value 'hi'",
			"Get-Content README.md | Tee-Object copy.md",
			"Remove-Item a.txt",
			"New-Item -ItemType File a.txt",
			"Copy-Item a.txt b.txt",
			"Move-Item a.txt b.txt",
			"Invoke-Expression 'ls'",
			"Get-ChildItem | ForEach-Object { Remove-Item $_ }",
			"pwsh -Command 'Get-ChildItem'",
			"powershell -EncodedCommand ZQBjAGgAbwA=",
			"& ./script.ps1",
			'Write-Output "$(Get-Date)"',
		];
		for (const cmd of mutatingPs) {
			const effect = classifyShellEffect(cmd, "powershell");
			expect(effect.kind, cmd).toBe("mutating");
		}
	});
});

describe("Tool-call summaries, exploration folding, and shell syntax highlighting", () => {
	it("summarizes bash and PowerShell commands via shared Shell Analysis", () => {
		expect(summarizeShellCommand("bash", `cd src && rg "a > b | c" . | head -n 5`)).toBe(
			'Search text "a > b | c" + 1 more step',
		);
		expect(summarizeShellCommand("bash", "git status --short")).toBe("Check repository status");
		expect(summarizeShellCommand("bash", "npm run build")).toBe("Run build task");
		expect(summarizeShellCommand("powershell", "Get-Content -Path README.md | Select-String -Pattern 'pi-ui'")).toBe(
			'Read file "README.md" + 1 more step',
		);
		expect(shellSegments(`rg "a && b" src && wc -l package.json`)).toEqual([
			`rg "a && b" src`,
			"wc -l package.json",
		]);
	});

	it("folds read-only inspection calls in Claude and Codex views while never folding mutating commands", () => {
		expect(lookKind("bash", { command: `rg "a > b" src 2>/dev/null | head -n 5` })).toBe("search");
		expect(lookKind("bash", { command: "cat README.md" })).toBe("read");
		expect(lookKind("bash", { command: "ls -la src" })).toBe("list");
		expect(lookKind("powershell", { command: "Get-Content README.md 2>$null" })).toBe("read");
		expect(lookKind("powershell", { command: "Select-String -Pattern 'foo' src/*.ts" })).toBe("search");

		expect(exploreActions("bash", { command: `rg "a > b" src | head -n 5` })).toEqual([
			{ kind: "search", query: "a > b", path: "src", command: "rg a > b src" },
		]);
		expect(exploreActions("bash", { command: "cat README.md" })).toEqual([
			{ kind: "read", name: "README.md" },
		]);

		/* Мутирующие команды никогда не должны сворачиваться в исследовательскую группу */
		const mutatingBash = [
			"cat a.txt > b.txt",
			"rg foo src >> matches.txt",
			"find . -delete",
			"find . -exec rm {} +",
			"fd -x rm",
			"rg --pre ./run.sh foo",
			"sed -i 's/a/b/' file.txt",
			"sed -ne 'w out.txt' file.txt",
			"awk '{system(\"id\")}' file.txt",
			"sort -o out.txt in.txt",
			"ls | xargs rm",
			"cat a.txt | tee b.txt",
			"echo $(rm -rf tmp)",
			"cat <<EOF\nhi\nEOF",
			"git commit -m 'x'",
			"node -e 'process.exit(0)'",
			"bash -c 'ls'",
			"npm install",
		];
		for (const command of mutatingBash) {
			expect(classifyShellCommand(command, "bash"), `claude: ${command}`).toBeUndefined();
			expect(lookKind("bash", { command }), `claude lookKind: ${command}`).toBeUndefined();
			expect(parseExploreCommand(command, "bash"), `codex: ${command}`).toBeUndefined();
			expect(exploreActions("bash", { command }), `codex exploreActions: ${command}`).toBeUndefined();
		}

		const mutatingPowerShell = [
			"Get-Content README.md > out.txt",
			"Get-Content README.md | Out-File out.txt",
			"Set-Content -Path a.txt -Value 'x'",
			"Get-ChildItem | Tee-Object list.txt",
			"Remove-Item a.txt",
			'Get-Content "$(Get-Location)/a.txt"',
		];
		for (const command of mutatingPowerShell) {
			expect(lookKind("powershell", { command }), `claude ps: ${command}`).toBeUndefined();
			expect(exploreActions("powershell", { command }), `codex ps: ${command}`).toBeUndefined();
		}
	});

	it("highlights bash and PowerShell commands losslessly via shared Shell Analysis token spans", async () => {
		const { dark: theme } = await loadPackageThemes();
		const bashCmd = `FOO=1 rg --glob '*.ts' "a > b" $HOME | head -n 5 # tail`;
		const bashHighlighted = highlightCommand(bashCmd, theme, "bash");
		expect(bashHighlighted).toHaveLength(1);
		expect(stripTerminalSequences(bashHighlighted[0]!)).toBe(bashCmd);
		expect(bashHighlighted[0]!).not.toBe(bashCmd);

		const multiLine = "git status\ngit diff --stat";
		const multiHighlighted = highlightCommand(multiLine, theme, "bash");
		expect(multiHighlighted).toHaveLength(2);
		expect(multiHighlighted.map((line) => stripTerminalSequences(line))).toEqual([
			"git status",
			"git diff --stat",
		]);

		const psCmd = `Get-Content -Path "a > \`"b\`".txt" 2>$null`;
		const psHighlighted = highlightCommand(psCmd, theme, "powershell");
		expect(psHighlighted).toHaveLength(1);
		expect(stripTerminalSequences(psHighlighted[0]!)).toBe(psCmd);
	});
});
