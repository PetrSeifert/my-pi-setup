import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WindowName = "5h" | "weekly";

interface LimitState {
	limit?: number;
	remaining?: number;
	usedPercent?: number;
	reset?: number;
}

const limits: Record<WindowName, LimitState> = {
	"5h": {},
	weekly: {},
};

let lastHeaders: Record<string, string> = {};
let lastStatus: number | undefined;

function parseNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = value.match(/\d+(?:\.\d+)?/);
	if (!match) return undefined;
	const numberValue = Number(match[0]);
	return Number.isFinite(numberValue) ? numberValue : undefined;
}

function parseReset(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) {
		return numeric > 10_000_000_000 ? numeric : numeric * 1000;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function findHeader(headers: Record<string, string>, patterns: RegExp[]): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (patterns.every((pattern) => pattern.test(name))) return value;
	}
	return undefined;
}

function updateWindow(headers: Record<string, string>, windowName: WindowName): void {
	const prefix = windowName === "5h" ? "x-codex-primary" : "x-codex-secondary";
	const windowPattern = windowName === "5h" ? /5h|5-hour|five-hour|primary/i : /week|weekly|7d|secondary/i;
	const nextLimit = parseNumber(findHeader(headers, [/limit/i, windowPattern]));
	const nextRemaining = parseNumber(findHeader(headers, [/remaining/i, windowPattern]));
	const nextUsedPercent = parseNumber(headers[`${prefix}-used-percent`] ?? findHeader(headers, [/used/i, /percent/i, windowPattern]));
	const nextReset = parseReset(headers[`${prefix}-reset-at`] ?? findHeader(headers, [/reset/i, windowPattern]));

	if (nextLimit !== undefined) limits[windowName].limit = nextLimit;
	if (nextRemaining !== undefined) limits[windowName].remaining = nextRemaining;
	if (nextUsedPercent !== undefined) limits[windowName].usedPercent = nextUsedPercent;
	if (nextReset !== undefined) limits[windowName].reset = nextReset;
}

function formatReset(reset: number | undefined): string {
	if (!reset) return "";
	const remainingMs = reset - Date.now();
	if (remainingMs <= 0) return " reset now";
	const minutes = Math.ceil(remainingMs / 60_000);
	if (minutes < 60) return ` resets ${minutes}m`;
	return ` resets ${Math.ceil(minutes / 60)}h`;
}

function formatWindow(name: WindowName, state: LimitState): string {
	if (state.limit !== undefined && state.remaining !== undefined) {
		const used = Math.max(0, state.limit - state.remaining);
		const percent = state.limit > 0 ? Math.round((used / state.limit) * 100) : 0;
		return `${name}: ${state.remaining}/${state.limit} left (${percent}% used)${formatReset(state.reset)}`;
	}
	if (state.usedPercent !== undefined) {
		return `${name}: ${state.usedPercent}% used${formatReset(state.reset)}`;
	}
	return `${name}: ?`;
}

function render(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const text = `${formatWindow("5h", limits["5h"])} | ${formatWindow("weekly", limits.weekly)}`;
	ctx.ui.setStatus("codex-limits", theme.fg("dim", text));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		render(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model.provider !== "openai-codex") return;
		lastStatus = event.status;
		lastHeaders = event.headers;
		updateWindow(event.headers, "5h");
		updateWindow(event.headers, "weekly");
		render(ctx);
	});

	pi.registerCommand("codex-limits-debug", {
		description: "Show the last Codex limit status parsed from response headers",
		handler: async (_args, ctx) => {
			render(ctx);
			const headerLines = Object.entries(lastHeaders)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, value]) => `${name}: ${value}`)
				.join("\n");
			ctx.ui.notify(
				`Status: ${lastStatus ?? "none"}\n${formatWindow("5h", limits["5h"])} | ${formatWindow("weekly", limits.weekly)}\n\n${headerLines || "No Codex response headers captured. Set /settings > transport to sse, send one prompt, then run this again."}`,
				"info",
			);
		},
	});
}
