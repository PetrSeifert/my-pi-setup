import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Editor, type EditorTheme, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATE_ENTRY = "plan-extension-state";
const HANDOFF_ENTRY = "plan-extension-handoff";
const HANDOFF_COMMAND = "plan-handoff";

type PlanExecutionTarget = "current" | "new";
type PlanReviewAction = PlanExecutionTarget | "revise";

interface PlanReviewResult {
	action: PlanReviewAction;
	plan: string;
}

interface CommandRunnerAPI {
	runCommand?: (command: string, options?: { waitForIdle?: boolean }) => void;
}

const START_PLAN_PROMPT = `You are now in planning mode.

Goal:
- Explore enough context to create a practical, executable plan for the user's problem.
- Prefer read-only exploration. Do not edit files, create files, delete files, or run destructive commands while planning unless the user explicitly asks for that during planning.
- Identify core decisions that materially affect the solution. Use ask_question for all user questions, setting each question's type to "single" or "multi".
- Avoid asking about minor implementation details that can be decided safely later.
- When you believe the plan is complete, call finish_plan with the final plan. Do not just print the final plan without calling finish_plan.

Plan quality:
- Include assumptions and constraints.
- Include the proposed approach and rationale.
- Include concrete ordered implementation steps.
- Include validation/testing steps.
- Include risks/open questions, if any.`;

const ACTIVE_PLANNING_SYSTEM = `Planning mode is active for this session.

Follow these rules until finish_plan is accepted and the user chooses how to execute the plan:
- Explore before planning, using read-only actions where possible.
- For core decisions, call ask_question and set each question's type to "single" or "multi" as appropriate.
- Do not implement the plan while planning mode is active.
- When the plan is ready, call finish_plan with the final plan and wait for the user's approval flow.`;

const StartPlanParams = Type.Object({
	problem: Type.String({ description: "The problem or goal to plan for." }),
});

const FinishPlanParams = Type.Object({
	plan: Type.String({ description: "The complete final plan in markdown." }),
});

let planningActive = false;
let nextPlanId = 1;
const pendingPlans = new Map<string, string>();

function setPlanningActive(pi: ExtensionAPI, active: boolean): void {
	planningActive = active;
	pi.appendEntry(STATE_ENTRY, { active, timestamp: Date.now() });
}

function buildPlanningPrompt(problem: string): string {
	return `${START_PLAN_PROMPT}\n\nUser problem to plan for:\n${problem.trim()}`;
}

function buildExecutionPrompt(plan: string): string {
	return `Planning mode is complete and implementation is now approved. Ignore earlier planning-mode restrictions that said not to implement; you may now use the available tools to execute the work. Use this approved plan as the starting point. Execute it carefully. If a serious issue with the plan appears, pause and ask before deviating.\n\n# Approved plan\n\n${plan.trim()}`;
}

function restorePlanningState(ctx: { sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> } }): void {
	planningActive = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const data = entry.data as { active?: unknown } | undefined;
		planningActive = data?.active === true;
	}
}

function findPersistedPlan(ctx: { sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> } }, id: string): string | undefined {
	let found: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== HANDOFF_ENTRY) continue;
		const data = entry.data as { id?: unknown; plan?: unknown } | undefined;
		if (data?.id === id && typeof data.plan === "string") found = data.plan;
	}
	return found;
}

function targetResultText(target: PlanExecutionTarget): string {
	return target === "current" ? "continuing current session" : "ready for new-session handoff";
}

async function reviewFinalPlan(ctx: ExtensionContext, plan: string): Promise<PlanReviewResult> {
	try {
		return await ctx.ui.custom<PlanReviewResult>(
			(tui, theme, _keybindings, done) => new PlanReviewWindow(tui, theme, plan, done),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "92%",
					minWidth: 60,
					maxHeight: "90%",
					margin: 1,
				},
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Plan review window unavailable (${message}). Falling back to the standard editor.`, "warning");
		return fallbackReviewFinalPlan(ctx, plan);
	}
}

async function fallbackReviewFinalPlan(ctx: ExtensionContext, plan: string): Promise<PlanReviewResult> {
	ctx.ui.notify("Review the full plan in the editor. Accept it there to continue, or cancel to keep planning.", "info");
	const reviewed = await ctx.ui.editor("Review/edit final plan", plan);
	const reviewedPlan = reviewed?.trim() ?? "";
	if (!reviewedPlan) return { action: "revise", plan };

	const choice = await ctx.ui.select("Approved plan - what next?", [
		"Continue in current session (keep planning context)",
		"Start a new session (clean handoff)",
		"Keep planning / revise",
	]);

	if (choice?.startsWith("Continue")) return { action: "current", plan: reviewedPlan };
	if (choice?.startsWith("Start")) return { action: "new", plan: reviewedPlan };
	return { action: "revise", plan: reviewedPlan };
}

class PlanReviewWindow implements Component, Focusable {
	private mode: "review" | "edit" = "review";
	private plan: string;
	private scroll = 0;
	private selectedAction = 0;
	private error: string | undefined;
	private editorRowsHint = 12;
	private readonly editor: Editor;
	private readonly actions: Array<{ action: PlanReviewAction | "edit"; label: string; shortcut: string }> = [
		{ action: "current", label: "Continue current", shortcut: "c" },
		{ action: "new", label: "New session", shortcut: "n" },
		{ action: "edit", label: "Edit", shortcut: "e" },
		{ action: "revise", label: "Keep planning", shortcut: "r" },
	];

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.mode === "edit";
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		initialPlan: string,
		private readonly done: (result: PlanReviewResult) => void,
	) {
		this.plan = initialPlan.trim();
		this.editor = new Editor(this.createEditorTui(tui), this.editorTheme(), { paddingX: 1 });
		this.editor.setText(this.plan);
		this.editor.onSubmit = () => {
			const edited = this.editor.getExpandedText().trim();
			if (!edited) {
				this.error = "Plan cannot be empty.";
				this.tui.requestRender();
				return;
			}
			this.plan = edited;
			this.mode = "review";
			this.scroll = 0;
			this.error = undefined;
			this.editor.focused = false;
			this.tui.requestRender();
		};
		this.editor.onChange = () => {
			this.error = undefined;
		};
	}

	handleInput(data: string): void {
		if (this.mode === "edit") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.mode = "review";
				this.editor.setText(this.plan);
				this.editor.focused = false;
				this.error = undefined;
				this.tui.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.submit("revise");
			return;
		}
		if (matchesKey(data, "up")) {
			this.scroll = Math.max(0, this.scroll - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scroll += 1;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - 8);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll += 8;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
			this.selectedAction = (this.selectedAction - 1 + this.actions.length) % this.actions.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.selectedAction = (this.selectedAction + 1) % this.actions.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.activate(this.actions[this.selectedAction]?.action ?? "current");
			return;
		}

		switch (data) {
			case "c":
			case "C":
				this.submit("current");
				return;
			case "n":
			case "N":
				this.submit("new");
				return;
			case "e":
			case "E":
				this.enterEditMode();
				return;
			case "r":
			case "R":
				this.submit("revise");
				return;
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const termRows = this.tui.terminal?.rows ?? 32;
		const maxBodyRows = Math.max(10, Math.floor(termRows * 0.88) - 2);
		const body = this.mode === "edit" ? this.renderEdit(innerWidth, maxBodyRows) : this.renderReview(innerWidth, maxBodyRows);
		return this.frame(body.slice(0, maxBodyRows), safeWidth, this.mode === "edit" ? "Edit final plan" : "Review final plan");
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private enterEditMode(): void {
		this.editor.setText(this.plan);
		this.mode = "edit";
		this.editor.focused = this._focused;
		this.error = undefined;
		this.tui.requestRender();
	}

	private activate(action: PlanReviewAction | "edit"): void {
		if (action === "edit") {
			this.enterEditMode();
			return;
		}
		this.submit(action);
	}

	private submit(action: PlanReviewAction): void {
		const reviewedPlan = this.plan.trim();
		if (!reviewedPlan && action !== "revise") {
			this.error = "Plan cannot be empty.";
			this.tui.requestRender();
			return;
		}
		this.done({ action, plan: reviewedPlan || this.plan });
	}

	private renderReview(width: number, rows: number): string[] {
		const lines: string[] = [];
		const wrappedPlan = this.wrappedPlanLines(width);
		lines.push(this.summaryLine());
		lines.push(
			this.theme.fg("dim", "↑/↓ scroll • PgUp/PgDn jump • ←/→ or Tab choose action • Enter select • e edit • Esc keep planning"),
		);
		if (this.error) lines.push(this.theme.fg("error", this.error));
		lines.push(this.theme.fg("border", "─".repeat(width)));

		const footerRows = 3;
		const contentRows = Math.max(3, rows - lines.length - footerRows);
		const maxScroll = Math.max(0, wrappedPlan.length - contentRows);
		this.scroll = clamp(this.scroll, 0, maxScroll);
		const visible = wrappedPlan.slice(this.scroll, this.scroll + contentRows);
		while (visible.length < contentRows) visible.push("");
		lines.push(...visible);

		if (wrappedPlan.length > contentRows) {
			const position = `${this.scroll + 1}-${Math.min(wrappedPlan.length, this.scroll + contentRows)}/${wrappedPlan.length}`;
			lines.push(this.theme.fg("dim", `… plan lines ${position}`));
		} else {
			lines.push("");
		}
		lines.push(this.theme.fg("border", "─".repeat(width)));
		lines.push(this.actionLine(width));
		return lines;
	}

	private renderEdit(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push(this.summaryLine());
		lines.push(this.theme.fg("dim", "Edit the plan, then Enter to save. Shift+Enter adds a newline. Esc cancels edits."));
		if (this.error) lines.push(this.theme.fg("error", this.error));
		lines.push(this.theme.fg("border", "─".repeat(width)));
		const remaining = Math.max(1, rows - lines.length);
		this.editorRowsHint = Math.max(1, remaining - 2);
		const editorRows = this.expandEditorRows(this.editor.render(width), width, remaining);
		lines.push(...editorRows.slice(0, remaining));
		while (lines.length < rows) lines.push("");
		return lines;
	}

	private expandEditorRows(editorRows: string[], width: number, targetRows: number): string[] {
		if (editorRows.length >= targetRows) return editorRows;
		const blanks = Array.from({ length: targetRows - editorRows.length }, () => " ".repeat(width));
		if (editorRows.length <= 1) return [...editorRows, ...blanks];
		const insertAt = editorRows.length - 1;
		return [...editorRows.slice(0, insertAt), ...blanks, ...editorRows.slice(insertAt)];
	}

	private createEditorTui(tui: TUI): TUI {
		const terminal = tui.terminal;
		const terminalProxy = new Proxy(terminal, {
			get: (target, prop, receiver) => {
				if (prop === "rows") {
					const actualRows = Reflect.get(target, prop, receiver) as number;
					const rowsNeededForFullHeight = Math.ceil(Math.max(5, this.editorRowsHint) / 0.3) + 2;
					return Math.max(actualRows, rowsNeededForFullHeight);
				}
				const value = Reflect.get(target, prop, receiver) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		return new Proxy(tui, {
			get: (target, prop, receiver) => {
				if (prop === "terminal") return terminalProxy;
				const value = Reflect.get(target, prop, receiver) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as TUI;
	}

	private summaryLine(): string {
		const chars = this.plan.length.toLocaleString();
		const logicalLines = Math.max(1, this.plan.split("\n").length).toLocaleString();
		return `${this.theme.fg("accent", "Finished plan")} • ${chars} chars • ${logicalLines} line(s) • choose where to execute it`;
	}

	private actionLine(width: number): string {
		const parts = this.actions.map((item, index) => {
			const label = ` ${item.shortcut}: ${item.label} `;
			return index === this.selectedAction ? this.theme.bg("selectedBg", this.theme.fg("accent", label)) : this.theme.fg("muted", label);
		});
		return truncateToWidth(parts.join(" "), width, "...", true);
	}

	private wrappedPlanLines(width: number): string[] {
		const text = normalizeDisplayText(this.plan);
		const result: string[] = [];
		for (const line of text.split("\n")) {
			if (!line) {
				result.push("");
				continue;
			}
			const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
			result.push(...(wrapped.length > 0 ? wrapped : [""]));
		}
		return result.length > 0 ? result.map((line) => truncateToWidth(line, width, "...")) : [""];
	}

	private frame(lines: string[], width: number, title: string): string[] {
		const innerWidth = Math.max(1, width - 2);
		const titleText = truncateToWidth(` ${title} `, Math.max(1, innerWidth));
		const titleWidth = visibleWidth(titleText);
		const left = Math.max(0, Math.floor((innerWidth - titleWidth) / 2));
		const right = Math.max(0, innerWidth - titleWidth - left);
		const border = (value: string) => this.theme.fg("border", value);
		const result = [
			border(`╭${"─".repeat(left)}`) + this.theme.fg("accent", titleText) + border(`${"─".repeat(right)}╮`),
		];
		for (const line of lines) {
			result.push(border("│") + this.padLine(line, innerWidth) + border("│"));
		}
		result.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return result.map((line) => truncateToWidth(line, width, "", true));
	}

	private padLine(line: string, width: number): string {
		return truncateToWidth(normalizeTuiLine(line), width, "...", true);
	}

	private editorTheme(): EditorTheme {
		return {
			borderColor: (s) => this.theme.fg("accent", s),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		};
	}
}

function normalizeDisplayText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

function normalizeTuiLine(line: string): string {
	return line.replace(/\t/g, "    ").replace(/\r/g, "").replace(/\n/g, "↵");
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export default function planExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		restorePlanningState(ctx);
		if (planningActive) ctx.ui.setStatus("plan", ctx.ui.theme.fg("accent", "planning"));
		else ctx.ui.setStatus("plan", undefined);
	});

	pi.on("before_agent_start", (event) => {
		if (!planningActive) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${ACTIVE_PLANNING_SYSTEM}` };
	});

	pi.registerCommand("plan", {
		description: "Start guided planning mode for a problem",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			let problem = args.trim();
			if (!problem) {
				problem = (await ctx.ui.input("Plan what?", "Describe the problem or goal to plan for..."))?.trim() ?? "";
			}
			if (!problem) {
				ctx.ui.notify("Plan cancelled: no problem provided.", "warning");
				return;
			}

			setPlanningActive(pi, true);
			ctx.ui.setStatus("plan", ctx.ui.theme.fg("accent", "planning"));
			pi.setSessionName(`Plan: ${problem.slice(0, 60)}${problem.length > 60 ? "…" : ""}`);
			pi.sendUserMessage(buildPlanningPrompt(problem));
		},
	});

	pi.registerCommand(HANDOFF_COMMAND, {
		description: "Internal: start a new session from an approved plan",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const id = args.trim();
			const plan = pendingPlans.get(id) ?? findPersistedPlan(ctx, id);
			if (!plan) {
				ctx.ui.notify("No pending approved plan was found for handoff.", "error");
				return;
			}
			pendingPlans.delete(id);

			const parentSession = ctx.sessionManager.getSessionFile();
			const result = await ctx.newSession({
				parentSession,
				withSession: async (newCtx) => {
					newCtx.ui.notify("Started a new session from the approved plan.", "info");
					await newCtx.sendUserMessage(buildExecutionPrompt(plan));
				},
			});

			if (result.cancelled) {
				pendingPlans.set(id, plan);
				ctx.ui.notify("New session handoff was cancelled.", "warning");
			}
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show whether planning mode is active",
		handler: async (_args, ctx) => {
			ctx.ui.notify(planningActive ? "Planning mode is active." : "Planning mode is not active.", "info");
		},
	});

	pi.registerTool({
		name: "start_plan",
		label: "Start Plan",
		description: "Start guided planning mode for a user problem. Use when the user or agent wants to explore first and create an approved plan before implementation.",
		promptSnippet: "Start guided planning mode for a problem before implementation",
		promptGuidelines: [
			"Use start_plan when the user asks to plan, brainstorm an implementation approach, or explore a problem before making changes.",
			"In planning mode, use ask_question for all user questions, setting each question's type to \"single\" or \"multi\", and use finish_plan when the final plan is ready.",
		],
		parameters: StartPlanParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setPlanningActive(pi, true);
			ctx.ui.setStatus("plan", ctx.ui.theme.fg("accent", "planning"));
			pi.sendUserMessage(buildPlanningPrompt(params.problem), { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Planning mode has been queued as a follow-up user message." }],
				details: { planningActive: true },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "finish_plan",
		label: "Finish Plan",
		description: "Submit the final planning-mode plan for user approval. If approved, the user chooses whether to continue in the current session or hand off to a new session.",
		promptSnippet: "Submit a final plan for user approval and choose current-session execution or new-session handoff",
		promptGuidelines: [
			"Use finish_plan only when the planning-mode plan is complete.",
			"finish_plan asks the user to review the final plan and choose whether to execute in the current session or hand off to a new session; do not separately ask the same approval question in chat.",
			"After finish_plan approval, stop; the plan extension queues the selected execution path.",
		],
		parameters: FinishPlanParams,
		renderCall(args, theme) {
			const plan = typeof (args as { plan?: unknown }).plan === "string" ? (args as { plan: string }).plan : "";
			const size = plan ? ` (${plan.length.toLocaleString()} chars)` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("finish_plan"))}${theme.fg("muted", ` reviewing plan${size}`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { approved?: boolean; target?: PlanExecutionTarget } | undefined;
			const text = details?.approved === true
				? `✓ Plan approved; ${targetResultText(details.target ?? "new")}`
				: details?.approved === false
					? "Planning continues"
					: "Plan review complete";
			return new Text(theme.fg(details?.approved === true ? "success" : "muted", text), 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const plan = params.plan.trim();
			if (!plan) throw new Error("finish_plan requires a non-empty plan.");

			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `No interactive UI is available. Present this plan in chat and ask the user whether they want to execute it in the current session or hand off to a new session:\n\n${plan}`,
						},
					],
					details: { needsChatApproval: true, plan },
				};
			}

			const review = await reviewFinalPlan(ctx, plan);
			const reviewedPlan = review.plan.trim();
			if (review.action === "revise" || !reviewedPlan) {
				ctx.ui.setEditorText("Please adjust the plan: ");
				ctx.ui.notify("Planning continues. Type what you want changed in the plan.", "info");
				return {
					content: [{ type: "text", text: "The user chose to keep planning or cancelled the plan review. Stop now and wait for the user's next prompt; planning mode remains active." }],
					details: { approved: false, plan: reviewedPlan || plan },
					terminate: true,
				};
			}

			setPlanningActive(pi, false);
			ctx.ui.setStatus("plan", undefined);

			if (review.action === "current") {
				pi.appendEntry(HANDOFF_ENTRY, { id: `current-${nextPlanId++}`, plan: reviewedPlan, target: "current", timestamp: Date.now() });
				pi.sendUserMessage(buildExecutionPrompt(reviewedPlan), { deliverAs: "followUp" });
				ctx.ui.notify("Plan approved. Continuing in the current session so the planning context is preserved.", "info");
				return {
					content: [{ type: "text", text: "The user approved the plan and chose to continue in the current session. Planning mode is off. A follow-up execution prompt has been queued. Stop now." }],
					details: { approved: true, target: "current", plan: reviewedPlan },
					terminate: true,
				};
			}

			const id = String(nextPlanId++);
			pendingPlans.set(id, reviewedPlan);
			pi.appendEntry(HANDOFF_ENTRY, { id, plan: reviewedPlan, target: "new", timestamp: Date.now() });
			const command = `/${HANDOFF_COMMAND} ${id}`;
			const runCommand = (pi as CommandRunnerAPI).runCommand;
			if (runCommand) {
				runCommand(command, { waitForIdle: true });
				ctx.ui.notify("Plan approved. A new session will start automatically after this turn finishes.", "info");
				return {
					content: [{ type: "text", text: `The user approved the plan and chose a new-session handoff. Planning mode is off. The handoff command has been scheduled programmatically: ${command}. Stop now.` }],
					details: { approved: true, target: "new", pendingPlanId: id, command, plan: reviewedPlan, scheduled: true },
					terminate: true,
				};
			}

			ctx.ui.setEditorText(command);
			ctx.ui.notify("Plan approved. Press Enter to run the prefilled handoff command and start the new session.", "info");

			return {
				content: [{ type: "text", text: `The user approved the plan and chose a new-session handoff. Planning mode is off. The handoff command has been placed in the editor: ${command}. Stop now; the user must press Enter to start the new session.` }],
				details: { approved: true, target: "new", pendingPlanId: id, command, plan: reviewedPlan, scheduled: false },
				terminate: true,
			};
		},
	});
}
