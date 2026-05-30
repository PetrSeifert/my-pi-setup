import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATE_ENTRY = "plan-extension-state";
const HANDOFF_ENTRY = "plan-extension-handoff";
const HANDOFF_COMMAND = "plan-handoff";

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

Follow these rules until finish_plan is accepted:
- Explore before planning, using read-only actions where possible.
- For core decisions, call ask_question and set each question's type to "single" or "multi" as appropriate.
- Do not implement the plan in this session.
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
	return `Use this approved plan as the starting point for the work. Execute it carefully. If a serious issue with the plan appears, pause and ask before deviating.\n\n# Approved plan\n\n${plan.trim()}`;
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
		description: "Submit the final planning-mode plan for user approval. If approved, pi prepares a handoff command that starts a new session and sends the approved plan as the first user message.",
		promptSnippet: "Submit a final plan for user approval and prepare handoff to a new session",
		promptGuidelines: [
			"Use finish_plan only when the planning-mode plan is complete.",
			"finish_plan asks the user whether they are happy with the plan; do not separately ask the same yes/no question in chat.",
			"After finish_plan approval, stop and wait for the user to run the prepared handoff command.",
		],
		parameters: FinishPlanParams,
		renderCall(args, theme) {
			const plan = typeof (args as { plan?: unknown }).plan === "string" ? (args as { plan: string }).plan : "";
			const size = plan ? ` (${plan.length.toLocaleString()} chars)` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("finish_plan"))}${theme.fg("muted", ` reviewing plan${size}`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { approved?: boolean } | undefined;
			const text = details?.approved === true
				? "✓ Plan approved; starting new session"
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
					content: [{ type: "text", text: `No interactive UI is available. Present this plan in chat and ask the user if they are happy with it:\n\n${plan}` }],
					details: { needsChatApproval: true, plan },
				};
			}

			ctx.ui.notify("Review the full plan in the editor. Accept it there to continue to approval, or cancel to keep planning.", "info");
			const reviewed = await ctx.ui.editor("Review/edit final plan", plan);
			const reviewedPlan = reviewed?.trim() ?? "";
			if (!reviewedPlan) {
				ctx.ui.setEditorText("Please adjust the plan: ");
				ctx.ui.notify("Planning continues. Type what you want changed in the plan.", "info");
				return {
					content: [{ type: "text", text: "The user cancelled or cleared the plan review. Stop now and wait for the user's next prompt; planning mode remains active." }],
					details: { approved: false, plan },
					terminate: true,
				};
			}

			const approved = await ctx.ui.confirm(
				"Approve reviewed plan?",
				`Start a new session with the reviewed plan (${reviewedPlan.length.toLocaleString()} characters) as the first user message?\n\nYes: start the new session.\nNo: stay in planning; type the changes you want next.`,
			);

			if (!approved) {
				ctx.ui.setEditorText("Please adjust the plan: ");
				ctx.ui.notify("Planning continues. Type what you want changed in the plan.", "info");
				return {
					content: [{ type: "text", text: "The user is not happy with the plan. Stop now and wait for the user's next prompt; planning mode remains active." }],
					details: { approved: false, plan: reviewedPlan },
					terminate: true,
				};
			}

			setPlanningActive(pi, false);
			ctx.ui.setStatus("plan", undefined);
			const id = String(nextPlanId++);
			pendingPlans.set(id, reviewedPlan);
			pi.appendEntry(HANDOFF_ENTRY, { id, plan: reviewedPlan, timestamp: Date.now() });
			const command = `/${HANDOFF_COMMAND} ${id}`;
			ctx.ui.setEditorText(command);
			ctx.ui.notify("Plan approved. Press Enter to run the prefilled handoff command and start the new session.", "info");

			return {
				content: [{ type: "text", text: `The user approved the plan. Planning mode is off. The handoff command has been placed in the editor: ${command}. Stop now; the user must press Enter to start the new session.` }],
				details: { approved: true, pendingPlanId: id, command },
				terminate: true,
			};
		},
	});
}
