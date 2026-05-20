import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CurrentStream {
	startedAt: number;
	firstTokenAt?: number;
	lastUpdateAt: number;
	textChars: number;
	thinkingChars: number;
	toolCallChars: number;
}

interface LastRun {
	elapsedMs: number;
	ttftMs?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	estimatedOutput: number;
}

let current: CurrentStream | undefined;
let last: LastRun | undefined;
let turns = 0;

function usageOf(message: unknown) {
	const usage = (message as AssistantMessage | undefined)?.usage;
	return {
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		cost: usage?.cost?.total ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
	};
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function fmtMs(ms: number | undefined): string {
	if (ms === undefined) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function estimatedTokens(s: CurrentStream): number {
	// Lightweight streaming estimate until provider usage arrives.
	return Math.max(0, Math.round((s.textChars + s.thinkingChars + s.toolCallChars) / 4));
}

function sessionTotals(ctx: ExtensionContext) {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let assistantMessages = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		assistantMessages++;
		const usage = usageOf(entry.message);
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		cost += usage.cost;
	}

	return { input, output, cacheRead, cacheWrite, cost, assistantMessages };
}

function render(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	// Footer statuses are intentionally rendered by pi on one shared line. Use a
	// small below-editor widget instead so token stats do not crowd codex-limits.
	ctx.ui.setStatus("token-stats", undefined);

	const context = ctx.getContextUsage();
	const ctxText = context?.tokens !== undefined
		? ` ctx ${fmtTokens(context.tokens)}${context.percent !== null && context.percent !== undefined ? `/${Math.round(context.percent)}%` : ""}`
		: "";

	if (current) {
		const elapsedMs = Math.max(1, Date.now() - current.startedAt);
		const est = estimatedTokens(current);
		const speed = est / (elapsedMs / 1000);
		ctx.ui.setWidget(
			"token-stats",
			[theme.fg("accent", "tok") + theme.fg("dim", ` ${speed.toFixed(1)} t/s · ${fmtTokens(est)} out · ttft ${fmtMs(current.firstTokenAt ? current.firstTokenAt - current.startedAt : undefined)}${ctxText}`)],
			{ placement: "belowEditor" },
		);
		return;
	}

	const totals = sessionTotals(ctx);
	const speed = last && last.output > 0 ? last.output / (last.elapsedMs / 1000) : undefined;
	const lastText = last ? ` last ${speed !== undefined ? `${speed.toFixed(1)} t/s` : `${fmtTokens(last.estimatedOutput)} est`} · ttft ${fmtMs(last.ttftMs)}` : "ready";
	ctx.ui.setWidget(
		"token-stats",
		[theme.fg("dim", `${lastText} · ↑${fmtTokens(totals.input)} ↓${fmtTokens(totals.output)} $${totals.cost.toFixed(3)}${ctxText}`)],
		{ placement: "belowEditor" },
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		render(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		turns++;
		render(ctx);
	});

	pi.on("message_start", (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		current = {
			startedAt: Date.now(),
			lastUpdateAt: Date.now(),
			textChars: 0,
			thinkingChars: 0,
			toolCallChars: 0,
		};
	});

	pi.on("message_update", (event, ctx) => {
		if (!current) return;
		const streamEvent = event.assistantMessageEvent;
		const now = Date.now();
		if ((streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta" || streamEvent.type === "toolcall_delta") && !current.firstTokenAt) {
			current.firstTokenAt = now;
		}
		if (streamEvent.type === "text_delta") current.textChars += streamEvent.delta.length;
		if (streamEvent.type === "thinking_delta") current.thinkingChars += streamEvent.delta.length;
		if (streamEvent.type === "toolcall_delta") current.toolCallChars += streamEvent.delta.length;
		current.lastUpdateAt = now;
		render(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const endedAt = Date.now();
		const stream = current;
		const usage = usageOf(event.message);
		last = {
			elapsedMs: Math.max(1, endedAt - (stream?.startedAt ?? endedAt)),
			ttftMs: stream?.firstTokenAt ? stream.firstTokenAt - stream.startedAt : undefined,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
			estimatedOutput: stream ? estimatedTokens(stream) : 0,
		};
		current = undefined;
		render(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		render(ctx);
	});

	pi.registerCommand("token-stats", {
		description: "Show token usage, speed, TTFT, context, and cost stats",
		handler: async (_args, ctx) => {
			render(ctx);
			const totals = sessionTotals(ctx);
			const context = ctx.getContextUsage();
			const lastSpeed = last && last.output > 0 ? last.output / (last.elapsedMs / 1000) : undefined;
			ctx.ui.notify(
				[
					`Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
					`Turns this runtime: ${turns}`,
					`Session: input ${fmtTokens(totals.input)}, output ${fmtTokens(totals.output)}, cache read ${fmtTokens(totals.cacheRead)}, cache write ${fmtTokens(totals.cacheWrite)}, cost $${totals.cost.toFixed(4)}`,
					`Context: ${context ? `${fmtTokens(context.tokens)} tokens${context.percent !== null && context.percent !== undefined ? ` (${Math.round(context.percent)}%)` : ""}` : "unknown"}`,
					last
						? `Last response: ${last.output ? fmtTokens(last.output) : `${fmtTokens(last.estimatedOutput)} estimated`} output tokens in ${(last.elapsedMs / 1000).toFixed(2)}s${lastSpeed !== undefined ? ` (${lastSpeed.toFixed(2)} t/s)` : ""}, TTFT ${fmtMs(last.ttftMs)}, cost $${last.cost.toFixed(4)}`
						: "Last response: none yet",
				].join("\n"),
				"info",
			);
		},
	});
}
