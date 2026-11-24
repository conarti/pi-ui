import {
	createBashToolDefinition,
	createCodemodeExtension,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const factories = {
	read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
	bash: createBashToolDefinition, powershell: createPowerShellToolDefinition,
	grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};
const builtinRenderers = new Map<string, { call: string; result: string }>();
for (const [name, factory] of Object.entries(factories)) {
	try {
		const definition = factory(process.cwd());
		builtinRenderers.set(name, { call: String(definition.renderCall), result: String(definition.renderResult) });
	} catch {
		/* Отсутствующий эталонный рендерер не должен блокировать загрузку UI. */
	}
}

/* Снимаем отпечаток встроенного codemode синхронно через корневой экспорт пакета хоста, чтобы совпадать с бандлом cli.js. */
if (typeof createCodemodeExtension === "function") {
	try {
		createCodemodeExtension()({
			registerTool(definition: ToolDefinition<any, any, any>) {
				if (typeof definition?.renderCall === "function" && typeof definition?.renderResult === "function") {
					builtinRenderers.set("codemode", {
						call: String(definition.renderCall),
						result: String(definition.renderResult),
					});
				}
			},
			appendEntry() {},
			getAllTools: () => [],
			getSettings: () => ({}),
		} as unknown as ExtensionAPI);
	} catch {
		/* На старых версиях хоста встроенный codemode может отсутствовать. */
	}
}

export function loadNativeTimerRenderers(): Promise<void> {
	return Promise.resolve();
}

/** Conservative fallback on legacy hosts without source metadata. */
export function hasAuthorRenderers(name: string, definition: ToolDefinition<any, any, any> | undefined): boolean {
	if (!definition) return false;
	const builtin = builtinRenderers.get(name);
	return Boolean((definition.renderCall && String(definition.renderCall) !== builtin?.call)
		|| (definition.renderResult && String(definition.renderResult) !== builtin?.result));
}

/**
 * Native shell rows own a one-second elapsed timer in their renderer state. Pause
 * it when leaving native rendering (without fabricating a final result), and seed
 * its start from the observed execution time when entering native rendering late.
 * Guard by the exact host renderer fingerprint: third-party state is not ours.
 */
export function syncNativeToolTimer(row: object, name: string, base: ToolDefinition<any, any, any> | undefined, native: boolean, timing?: { startedAt: number; endedAt?: number }): void {
	if (!base || !builtinRenderers.has(name) || !["bash", "powershell", "codemode"].includes(name) || hasAuthorRenderers(name, base)) return;
	const state = (row as { rendererState?: { startedAt?: number; endedAt?: number; interval?: ReturnType<typeof setInterval> } }).rendererState;
	if (!state) return;
	if (native) {
		if (state.startedAt === undefined && timing) state.startedAt = timing.startedAt;
		if (state.endedAt === undefined && timing?.endedAt !== undefined) state.endedAt = timing.endedAt;
	} else if (state.interval !== undefined) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

/** Change only a transcript row's renderer shell, never a tool registry entry. */
export function refreshRowShell(row: object): void {
	const target = row as {
		children?: unknown[]; selfRenderContainer?: unknown; contentBox?: unknown; contentTextRegion?: unknown;
		hasRendererDefinition?(): boolean; getRenderShell?(): string;
		callRendererComponent?: unknown; resultRendererComponent?: unknown;
	};
	if (!Array.isArray(target.children) || !target.selfRenderContainer || !target.contentBox || !target.contentTextRegion) return;
	const wanted = target.hasRendererDefinition?.()
		? target.getRenderShell?.() === "self" ? target.selfRenderContainer : target.contentBox
		: target.contentTextRegion;
	const shells: unknown[] = [target.selfRenderContainer, target.contentBox, target.contentTextRegion];
	const index = target.children.findIndex((child) => shells.includes(child));
	if (index >= 0 && target.children[index] !== wanted) {
		target.children[index] = wanted;
		target.callRendererComponent = undefined;
		target.resultRendererComponent = undefined;
	}
}
