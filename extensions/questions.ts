import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	answer?: string;
	choice?: number | "custom";
	cancelled?: boolean;
	recommendedIndex?: number;
	needsChatQuestion?: boolean;
}

interface AskMultiQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	answers: string[];
	selectedIndexes: number[];
	cancelled?: boolean;
	needsChatQuestion?: boolean;
	minSelections: number;
	maxSelections?: number;
}

interface MultiSelectResult {
	answers: string[];
	selectedIndexes: number[];
}

const AskQuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user." }),
	context: Type.Optional(Type.String({ description: "Short context explaining why the question matters." })),
	options: Type.Array(Type.String({ description: "A concrete answer option the user can choose." }), {
		minItems: 1,
		description: "Answer options to show. The UI can also add a custom answer option.",
	}),
	recommendedIndex: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Optional 1-based index of the recommended option.",
		}),
	),
	allowCustom: Type.Optional(Type.Boolean({ description: "Whether to let the user type a custom answer. Defaults to true." })),
});

const AskMultiQuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user." }),
	context: Type.Optional(Type.String({ description: "Short context explaining why the question matters." })),
	options: Type.Array(Type.String({ description: "A concrete answer option the user can select." }), {
		minItems: 1,
		description: "Answer options to show as checkboxes.",
	}),
	defaultSelectedIndexes: Type.Optional(
		Type.Array(Type.Number({ minimum: 1, description: "1-based option index selected by default." }), {
			description: "Optional 1-based option indexes selected by default.",
		}),
	),
	minSelections: Type.Optional(Type.Number({ minimum: 0, description: "Minimum number of answers the user must select. Defaults to 1." })),
	maxSelections: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of answers the user may select." })),
});

function introText(context: string | undefined, question: string): string {
	return [context?.trim(), "", question.trim()].filter(Boolean).join("\n");
}

function normalizeRecommendedIndex(value: number | undefined, optionCount: number): number | undefined {
	if (value === undefined) return undefined;
	const index = Math.round(value);
	if (index < 1 || index > optionCount) throw new Error(`recommendedIndex must be between 1 and ${optionCount}.`);
	return index;
}

function validateSelectionBounds(optionCount: number, minSelections: number, maxSelections: number | undefined): void {
	if (minSelections < 0) throw new Error("minSelections must be 0 or greater.");
	if (minSelections > optionCount) throw new Error(`minSelections cannot exceed the number of options (${optionCount}).`);
	if (maxSelections !== undefined) {
		if (maxSelections < 1) throw new Error("maxSelections must be 1 or greater.");
		if (maxSelections < minSelections) throw new Error("maxSelections cannot be less than minSelections.");
		if (maxSelections > optionCount) throw new Error(`maxSelections cannot exceed the number of options (${optionCount}).`);
	}
}

function normalizeSelectedIndexes(values: number[] | undefined, optionCount: number, maxSelections: number | undefined): Set<number> {
	const selected = new Set<number>();
	for (const value of values ?? []) {
		const index = Math.round(value) - 1;
		if (index >= 0 && index < optionCount) selected.add(index);
	}

	if (maxSelections !== undefined && selected.size > maxSelections) {
		return new Set([...selected].slice(0, maxSelections));
	}
	return selected;
}

function selectedIndexList(selected: Set<number>): number[] {
	return [...selected].sort((a, b) => a - b).map((index) => index + 1);
}

function selectedAnswers(options: string[], selected: Set<number>): string[] {
	return [...selected].sort((a, b) => a - b).map((index) => options[index]).filter((option): option is string => option !== undefined);
}

function selectionSummary(count: number, minSelections: number, maxSelections: number | undefined): string {
	if (maxSelections !== undefined && minSelections === maxSelections) return `Select exactly ${minSelections}.`;
	if (maxSelections !== undefined) return `Select ${minSelections}-${maxSelections}.`;
	if (minSelections > 0) return `Select at least ${minSelections}.`;
	return "Select any number.";
}

async function askMultiSelect(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: string[],
	defaultSelectedIndexes: number[] | undefined,
	minSelections: number,
	maxSelections: number | undefined,
): Promise<MultiSelectResult | null> {
	return ctx.ui.custom<MultiSelectResult | null>((tui, theme, _keybindings, done) => {
		let cursor = 0;
		let message: string | undefined;
		let cachedLines: string[] | undefined;
		const selected = normalizeSelectedIndexes(defaultSelectedIndexes, options.length, maxSelections);

		function count(): number {
			return selected.size;
		}

		function canSubmit(): boolean {
			if (count() < minSelections) return false;
			if (maxSelections !== undefined && count() > maxSelections) return false;
			return true;
		}

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function toggleCurrent(): void {
			message = undefined;
			if (selected.has(cursor)) {
				selected.delete(cursor);
				refresh();
				return;
			}
			if (maxSelections !== undefined && selected.size >= maxSelections) {
				message = `Maximum ${maxSelections} selection${maxSelections === 1 ? "" : "s"}.`;
				refresh();
				return;
			}
			selected.add(cursor);
			refresh();
		}

		function submit(): void {
			if (!canSubmit()) {
				message = selectionSummary(count(), minSelections, maxSelections);
				refresh();
				return;
			}
			done({ answers: selectedAnswers(options, selected), selectedIndexes: selectedIndexList(selected) });
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				message = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.min(options.length - 1, cursor + 1);
				message = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				toggleCurrent();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				submit();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const border = "─".repeat(Math.max(0, width));
			const add = (line: string) => lines.push(truncateToWidth(line, width));

			add(theme.fg("accent", border));
			const intro = introText(context, question).split("\n");
			for (const line of intro) add(line ? theme.fg("text", ` ${line}`) : "");
			lines.push("");

			for (let i = 0; i < options.length; i++) {
				const checked = selected.has(i);
				const isCursor = i === cursor;
				const pointer = isCursor ? theme.fg("accent", "> ") : "  ";
				const box = checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const option = isCursor ? theme.fg("accent", options[i]) : theme.fg("text", options[i]);
				add(`${pointer}${box} ${i + 1}. ${option}`);
			}

			lines.push("");
			const statusColor = canSubmit() ? "dim" : "warning";
			add(theme.fg(statusColor, ` ${count()} selected. ${selectionSummary(count(), minSelections, maxSelections)}`));
			if (message) add(theme.fg("warning", ` ${message}`));
			add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter submit • Esc cancel"));
			add(theme.fg("accent", border));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

export default function questions(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: "Ask the user a single-answer question with selectable options and an optional custom answer. Use whenever you need user input, not only during planning.",
		promptSnippet: "Ask the user a single-answer question with options",
		promptGuidelines: [
			"Use ask_question when you need one user decision, preference, confirmation, or clarification before proceeding.",
			"Use ask_question for single-answer questions; use ask_multi_question when the user can choose multiple answers.",
		],
		parameters: AskQuestionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.options.length === 0) throw new Error("ask_question requires at least one option.");
			const recommendedIndex = normalizeRecommendedIndex(params.recommendedIndex, params.options.length);
			const allowCustom = params.allowCustom !== false;
			const intro = introText(params.context, params.question);

			if (!ctx.hasUI) {
				const lines = [
					intro,
					...params.options.map((option, index) => `${index + 1}. ${option}${index + 1 === recommendedIndex ? " (recommended)" : ""}`),
				];
				if (allowCustom) lines.push(`${params.options.length + 1}. Custom answer`);
				return {
					content: [{ type: "text", text: `No interactive UI is available. Ask the user this question in chat:\n\n${lines.join("\n")}` }],
					details: { question: params.question, context: params.context, options: params.options, recommendedIndex, needsChatQuestion: true } satisfies AskQuestionDetails,
				};
			}

			const labels = params.options.map((option, index) => `${index + 1}. ${option}${index + 1 === recommendedIndex ? "  [recommended]" : ""}`);
			const customLabel = `${params.options.length + 1}. Custom answer…`;
			const choices = allowCustom ? [...labels, customLabel] : labels;
			const selected = await ctx.ui.select(intro, choices);

			if (!selected) {
				return {
					content: [{ type: "text", text: "The user dismissed the question dialog. Ask for the answer in chat and wait for their response." }],
					details: { question: params.question, context: params.context, options: params.options, cancelled: true, recommendedIndex } satisfies AskQuestionDetails,
				};
			}

			let answer: string;
			let choice: number | "custom";
			if (selected === customLabel) {
				answer = (await ctx.ui.editor("Custom answer", ""))?.trim() ?? "";
				choice = "custom";
				if (!answer) {
					return {
						content: [{ type: "text", text: "The user selected custom but did not provide an answer. Ask for the answer in chat and wait for their response." }],
						details: { question: params.question, context: params.context, options: params.options, cancelled: true, choice, recommendedIndex } satisfies AskQuestionDetails,
					};
				}
			} else {
				const index = labels.indexOf(selected);
				choice = index + 1;
				answer = params.options[index] ?? selected;
			}

			return {
				content: [{ type: "text", text: `User answer: ${answer}` }],
				details: { question: params.question, context: params.context, options: params.options, answer, choice, recommendedIndex } satisfies AskQuestionDetails,
			};
		},
		renderCall(args, theme) {
			const options = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("ask_question ")) + theme.fg("muted", String(args.question ?? ""));
			if (options.length > 0) {
				text += `\n${theme.fg("dim", `  Options: ${options.map((option, index) => `${index + 1}. ${String(option)}`).join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AskQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
			if (!details.answer) return new Text(theme.fg("muted", details.needsChatQuestion ? "Needs chat answer" : "No answer"), 0, 0);
			const prefix = details.choice === "custom" ? "(custom) " : details.choice ? `${details.choice}. ` : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `${prefix}${details.answer}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "ask_multi_question",
		label: "Ask Multi Question",
		description: "Ask the user a question where multiple answers may be selected with checkboxes. Use whenever more than one option can apply.",
		promptSnippet: "Ask the user a multiple-answer checkbox question",
		promptGuidelines: [
			"Use ask_multi_question when the user can select multiple answers to a question.",
			"Use ask_question instead when exactly one answer should be selected.",
		],
		parameters: AskMultiQuestionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.options.length === 0) throw new Error("ask_multi_question requires at least one option.");
			const minSelections = Math.round(params.minSelections ?? 1);
			const maxSelections = params.maxSelections === undefined ? undefined : Math.round(params.maxSelections);
			validateSelectionBounds(params.options.length, minSelections, maxSelections);
			const intro = introText(params.context, params.question);

			if (!ctx.hasUI) {
				const lines = [intro, ...params.options.map((option, index) => `[ ] ${index + 1}. ${option}`), selectionSummary(0, minSelections, maxSelections)];
				return {
					content: [{ type: "text", text: `No interactive UI is available. Ask the user this multiple-answer question in chat:\n\n${lines.join("\n")}` }],
					details: {
						question: params.question,
						context: params.context,
						options: params.options,
						answers: [],
						selectedIndexes: [],
						needsChatQuestion: true,
						minSelections,
						maxSelections,
					} satisfies AskMultiQuestionDetails,
				};
			}

			const result = await askMultiSelect(ctx, params.question, params.context, params.options, params.defaultSelectedIndexes, minSelections, maxSelections);

			if (!result) {
				return {
					content: [{ type: "text", text: "The user dismissed the multi-answer question dialog. Ask for the answer in chat and wait for their response." }],
					details: {
						question: params.question,
						context: params.context,
						options: params.options,
						answers: [],
						selectedIndexes: [],
						cancelled: true,
						minSelections,
						maxSelections,
					} satisfies AskMultiQuestionDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User selected ${result.answers.length} answer${result.answers.length === 1 ? "" : "s"}: ${result.answers.join(", ")}` }],
				details: {
					question: params.question,
					context: params.context,
					options: params.options,
					answers: result.answers,
					selectedIndexes: result.selectedIndexes,
					minSelections,
					maxSelections,
				} satisfies AskMultiQuestionDetails,
			};
		},
		renderCall(args, theme) {
			const options = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("ask_multi_question ")) + theme.fg("muted", String(args.question ?? ""));
			if (options.length > 0) {
				text += `\n${theme.fg("dim", `  Options: ${options.map((option, index) => `${index + 1}. ${String(option)}`).join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AskMultiQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
			if (details.needsChatQuestion) return new Text(theme.fg("muted", "Needs chat answer"), 0, 0);
			const lines = details.answers.map((answer, index) => {
				const selectedIndex = details.selectedIndexes[index];
				return `${theme.fg("success", "☑ ")}${theme.fg("accent", `${selectedIndex}. ${answer}`)}`;
			});
			return new Text(lines.length > 0 ? lines.join("\n") : theme.fg("muted", "No answers selected"), 0, 0);
		},
	});
}
