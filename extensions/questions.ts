import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, type KeybindingsManager, type KeyId, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const MAX_QUESTIONS = 3;
const SELECT_PAGE_STEP = 5;

type QuestionType = "single" | "multi";

type UiTheme = ExtensionContext["ui"]["theme"];
type SelectKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel";

interface NormalizedOption {
	label: string;
	value: string;
	description?: string;
}

interface NormalizedQuestion {
	id: string;
	label: string;
	type: QuestionType;
	question: string;
	context?: string;
	options: NormalizedOption[];
	recommendedIndex?: number;
	defaultSelectedIndexes?: number[];
	minSelections?: number;
	maxSelections?: number;
}

interface QuestionAnswer {
	id: string;
	label: string;
	type: QuestionType;
	indexes: number[];
	labels: string[];
	values: string[];
	isCustom?: boolean;
	customAnswer?: string;
}

interface AskQuestionDetails {
	questions: NormalizedQuestion[];
	answers: QuestionAnswer[];
	cancelled?: boolean;
	needsChatQuestion?: boolean;
}

interface LegacySingleQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	answer?: string;
	choice?: number | "custom";
	cancelled?: boolean;
	recommendedIndex?: number;
	needsChatQuestion?: boolean;
}

interface LegacyMultiQuestionDetails {
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

interface SingleQuestionState {
	type: "single";
	index?: number;
	customAnswer?: string;
}

interface MultiQuestionState {
	type: "multi";
	selected: Set<number>;
}

type QuestionState = SingleQuestionState | MultiQuestionState;

const editorTheme = (theme: UiTheme): EditorTheme => ({
	borderColor: (s) => theme.fg("accent", s),
	selectList: {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	},
});

const QuestionOptionParams = Type.Object({
	label: Type.String({ description: "Display label for this option." }),
	value: Type.Optional(Type.String({ description: "Optional stable value returned when this option is selected. Defaults to label." })),
	description: Type.Optional(Type.String({ description: "Optional short description shown below the label." })),
});

const QuestionParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional stable id for this question. Defaults to q1, q2, etc." })),
	label: Type.Optional(Type.String({ description: "Optional short label for tabs/results. Defaults to Q1, Q2, etc." })),
	type: StringEnum(["single", "multi"] as const, { description: "Question type: single-choice or multi-select." }),
	question: Type.String({ description: "The question to ask the user." }),
	context: Type.Optional(Type.String({ description: "Short context explaining why the question matters." })),
	options: Type.Array(QuestionOptionParams, {
		minItems: 1,
		description: "Answer options. String options are accepted as a compatibility shorthand and normalized to { label }. For single questions, a custom answer option is automatically added; do not include one yourself.",
	}),
	recommendedIndex: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "For type=single, optional 1-based index of the recommended option.",
		}),
	),
	defaultSelectedIndexes: Type.Optional(
		Type.Array(Type.Number({ minimum: 1, description: "1-based option index selected by default." }), {
			description: "For type=multi, optional default selected option indexes.",
		}),
	),
	minSelections: Type.Optional(Type.Number({ minimum: 0, description: "For type=multi, minimum selections. Defaults to 1." })),
	maxSelections: Type.Optional(Type.Number({ minimum: 1, description: "For type=multi, maximum selections." })),
});

const AskQuestionParams = Type.Object({
	questions: Type.Array(QuestionParams, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `One to ${MAX_QUESTIONS} questions to ask in a single UI flow.`,
	}),
});

type AskQuestionParams = Static<typeof AskQuestionParams>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function normalizeRawOption(option: unknown): unknown {
	if (typeof option === "string") return { label: option };
	return option;
}

function prepareQuestionObject(raw: unknown, defaultType?: QuestionType): unknown {
	if (!isRecord(raw)) return raw;
	const type = raw.type ?? raw.kind ?? defaultType;
	const options = Array.isArray(raw.options) ? raw.options.map(normalizeRawOption) : raw.options;
	return compactRecord({
		id: raw.id,
		label: raw.label,
		type,
		question: raw.question,
		context: raw.context,
		options,
		recommendedIndex: raw.recommendedIndex,
		defaultSelectedIndexes: raw.defaultSelectedIndexes,
		minSelections: raw.minSelections,
		maxSelections: raw.maxSelections,
	});
}

function prepareAskQuestionArguments(args: unknown): AskQuestionParams {
	if (!isRecord(args)) return args as AskQuestionParams;

	if (Array.isArray(args.questions)) {
		return { questions: args.questions.map((question) => prepareQuestionObject(question)) } as AskQuestionParams;
	}

	// Legacy ask_question({ question, context?, options: string[], recommendedIndex?, allowCustom? }) support.
	// allowCustom is intentionally ignored: single questions always include a custom answer option.
	if (typeof args.question === "string" && Array.isArray(args.options)) {
		return {
			questions: [
				prepareQuestionObject(
					{
						question: args.question,
						context: args.context,
						options: args.options,
						recommendedIndex: args.recommendedIndex,
					},
					"single",
				),
			],
		} as AskQuestionParams;
	}

	return args as AskQuestionParams;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

function matchesBinding(keybindings: KeybindingsManager, data: string, keybinding: SelectKeybinding, fallback: KeyId): boolean {
	return keybindings.matches(data, keybinding) || matchesKey(data, fallback);
}

function borderLine(theme: UiTheme, width: number): string {
	return theme.fg("accent", "─".repeat(Math.max(0, width)));
}

function addIntroLines(add: (line: string) => void, theme: UiTheme, context: string | undefined, question: string): void {
	const contextText = context?.trim();
	if (contextText) {
		for (const line of contextText.split(/\r?\n/)) add(line ? theme.fg("muted", ` ${line}`) : "");
		add("");
	}
	for (const line of question.trim().split(/\r?\n/)) add(line ? theme.fg("text", ` ${line}`) : "");
}

function invalidateCache(cache: { cachedWidth?: number; cachedLines?: string[] }): void {
	cache.cachedWidth = undefined;
	cache.cachedLines = undefined;
}

function introText(context: string | undefined, question: string): string {
	return [context?.trim(), "", question.trim()].filter(Boolean).join("\n");
}

function normalizeRecommendedIndex(value: number | undefined, optionCount: number): number | undefined {
	if (value === undefined) return undefined;
	const index = Math.round(value);
	if (index < 1 || index > optionCount) throw new Error(`recommendedIndex must be between 1 and ${optionCount}.`);
	return index;
}

function normalizeBound(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.round(value);
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

function normalizeSelectedIndexes(values: number[] | undefined, optionCount: number, maxSelections: number | undefined): number[] {
	const selected = new Set<number>();
	for (const value of values ?? []) {
		const index = Math.round(value);
		if (index < 1 || index > optionCount) throw new Error(`defaultSelectedIndexes contains ${value}, but valid indexes are 1-${optionCount}.`);
		selected.add(index);
	}
	if (maxSelections !== undefined && selected.size > maxSelections) {
		throw new Error(`defaultSelectedIndexes cannot include more than maxSelections (${maxSelections}) options.`);
	}
	return [...selected].sort((a, b) => a - b);
}

function selectedIndexList(selected: Set<number>): number[] {
	return [...selected].sort((a, b) => a - b).map((index) => index + 1);
}

function selectionSummary(minSelections: number, maxSelections: number | undefined): string {
	if (maxSelections !== undefined && minSelections === maxSelections) return `Select exactly ${minSelections}.`;
	if (maxSelections !== undefined) return `Select ${minSelections}-${maxSelections}.`;
	if (minSelections > 0) return `Select at least ${minSelections}.`;
	return "Select any number.";
}

function normalizeQuestions(params: AskQuestionParams): NormalizedQuestion[] {
	if (!Array.isArray(params.questions) || params.questions.length === 0) throw new Error("ask_question requires at least one question.");
	if (params.questions.length > MAX_QUESTIONS) throw new Error(`ask_question accepts at most ${MAX_QUESTIONS} questions per call.`);

	const ids = new Set<string>();
	return params.questions.map((question, index) => {
		const id = (question.id?.trim() || `q${index + 1}`).trim();
		const label = (question.label?.trim() || `Q${index + 1}`).trim();
		const text = question.question.trim();
		const context = question.context?.trim() || undefined;
		if (!id) throw new Error(`Question ${index + 1} has an empty id.`);
		if (ids.has(id)) throw new Error(`Question ids must be unique; duplicate id: ${id}.`);
		ids.add(id);
		if (!label) throw new Error(`Question ${index + 1} has an empty label.`);
		if (!text) throw new Error(`Question ${index + 1} has an empty question.`);
		if (question.type !== "single" && question.type !== "multi") throw new Error(`Question ${index + 1} type must be "single" or "multi".`);
		if (!Array.isArray(question.options) || question.options.length === 0) throw new Error(`Question ${index + 1} requires at least one option.`);

		const options = question.options.map((option, optionIndex) => {
			const optionLabel = option.label.trim();
			if (!optionLabel) throw new Error(`Question ${index + 1}, option ${optionIndex + 1} has an empty label.`);
			const description = option.description?.trim() || undefined;
			return {
				label: optionLabel,
				value: option.value ?? optionLabel,
				...(description ? { description } : {}),
			};
		});

		if (question.type === "single") {
			return {
				id,
				label,
				type: "single",
				question: text,
				context,
				options,
				recommendedIndex: normalizeRecommendedIndex(question.recommendedIndex, options.length),
			};
		}

		const minSelections = normalizeBound(question.minSelections) ?? 1;
		const maxSelections = normalizeBound(question.maxSelections);
		validateSelectionBounds(options.length, minSelections, maxSelections);
		const defaultSelectedIndexes = normalizeSelectedIndexes(question.defaultSelectedIndexes, options.length, maxSelections);
		return {
			id,
			label,
			type: "multi",
			question: text,
			context,
			options,
			defaultSelectedIndexes,
			minSelections,
			maxSelections,
		};
	});
}

function questionOptionsForSingle(question: NormalizedQuestion): Array<NormalizedOption & { isCustom?: boolean }> {
	return [...question.options, { label: "Custom answer…", value: "__custom__", isCustom: true }];
}

function defaultCursor(question: NormalizedQuestion): number {
	if (question.type === "single" && question.recommendedIndex !== undefined) return question.recommendedIndex - 1;
	return 0;
}

function initialQuestionState(question: NormalizedQuestion): QuestionState {
	if (question.type === "single") return { type: "single" };
	return { type: "multi", selected: new Set(question.defaultSelectedIndexes?.map((index) => index - 1) ?? []) };
}

function getQuestionState(states: Map<string, QuestionState>, question: NormalizedQuestion): QuestionState {
	let state = states.get(question.id);
	if (!state) {
		state = initialQuestionState(question);
		states.set(question.id, state);
	}
	return state;
}

function isMultiState(state: QuestionState): state is MultiQuestionState {
	return state.type === "multi";
}

function isSingleState(state: QuestionState): state is SingleQuestionState {
	return state.type === "single";
}

function multiSelectionIsValid(question: NormalizedQuestion, selected: Set<number>): boolean {
	const minSelections = question.minSelections ?? 1;
	const maxSelections = question.maxSelections;
	if (selected.size < minSelections) return false;
	if (maxSelections !== undefined && selected.size > maxSelections) return false;
	return true;
}

function answerFromState(question: NormalizedQuestion, state: QuestionState, confirmedMultiIds: Set<string>): QuestionAnswer | undefined {
	if (question.type === "single") {
		if (!isSingleState(state)) return undefined;
		if (state.customAnswer !== undefined) {
			return {
				id: question.id,
				label: question.label,
				type: "single",
				indexes: [],
				labels: [state.customAnswer],
				values: [state.customAnswer],
				isCustom: true,
				customAnswer: state.customAnswer,
			};
		}
		if (state.index !== undefined) {
			const option = question.options[state.index - 1];
			if (!option) return undefined;
			return {
				id: question.id,
				label: question.label,
				type: "single",
				indexes: [state.index],
				labels: [option.label],
				values: [option.value],
			};
		}
		return undefined;
	}

	if (!isMultiState(state) || !confirmedMultiIds.has(question.id) || !multiSelectionIsValid(question, state.selected)) return undefined;
	const indexes = selectedIndexList(state.selected);
	const selectedOptions = indexes.map((index) => question.options[index - 1]).filter((option): option is NormalizedOption => option !== undefined);
	return {
		id: question.id,
		label: question.label,
		type: "multi",
		indexes,
		labels: selectedOptions.map((option) => option.label),
		values: selectedOptions.map((option) => option.value),
	};
}

function answerSummary(answer: QuestionAnswer): string {
	if (answer.type === "single") {
		const prefix = answer.isCustom ? "user wrote" : `user selected ${answer.indexes[0]}.`;
		return `${answer.label}: ${prefix} ${answer.labels[0] ?? ""}`.trim();
	}
	if (answer.labels.length === 0) return `${answer.label}: user selected no options`;
	const selected = answer.labels.map((label, index) => `${answer.indexes[index]}. ${label}`).join(", ");
	return `${answer.label}: user selected ${selected}`;
}

function detailsForFallback(questions: NormalizedQuestion[]): AskQuestionDetails {
	return { questions, answers: [], needsChatQuestion: true };
}

function formatQuestionForChat(question: NormalizedQuestion): string {
	const lines: string[] = [];
	lines.push(`${question.label} (${question.type}):`);
	const intro = introText(question.context, question.question);
	if (intro) lines.push(intro);
	if (question.type === "single") {
		for (const [index, option] of question.options.entries()) {
			const recommended = question.recommendedIndex === index + 1 ? " (recommended)" : "";
			const description = option.description ? ` — ${option.description}` : "";
			lines.push(`${index + 1}. ${option.label}${recommended}${description}`);
		}
		lines.push(`${question.options.length + 1}. Custom answer`);
	} else {
		for (const [index, option] of question.options.entries()) {
			const selected = question.defaultSelectedIndexes?.includes(index + 1) ? "x" : " ";
			const description = option.description ? ` — ${option.description}` : "";
			lines.push(`[${selected}] ${index + 1}. ${option.label}${description}`);
		}
		lines.push(selectionSummary(question.minSelections ?? 1, question.maxSelections));
	}
	return lines.join("\n");
}

function chatFallbackResult(questions: NormalizedQuestion[]) {
	const label = questions.length === 1 ? "this question" : "these questions";
	return {
		content: [
			{
				type: "text" as const,
				text: `No interactive UI is available. Ask the user ${label} in chat and wait for their response:\n\n${questions.map(formatQuestionForChat).join("\n\n")}`,
			},
		],
		details: detailsForFallback(questions),
	};
}

async function askQuestionnaire(ctx: ExtensionContext, questions: NormalizedQuestion[]): Promise<AskQuestionDetails | undefined> {
	const isBatch = questions.length > 1;
	const submitTabIndex = questions.length;
	const totalTabs = questions.length + 1;

	return ctx.ui.custom<AskQuestionDetails | undefined>((tui, theme, keybindings, done) => {
		let currentTab = 0;
		let inputQuestionId: string | null = null;
		let message: string | undefined;
		const cache: { cachedWidth?: number; cachedLines?: string[] } = {};
		const states = new Map<string, QuestionState>();
		const cursors = new Map<string, number>();
		const confirmedMultiIds = new Set<string>();
		const editor = new Editor(tui, editorTheme(theme));

		for (const question of questions) getQuestionState(states, question);

		function refresh(): void {
			invalidateCache(cache);
			tui.requestRender();
		}

		function currentQuestion(): NormalizedQuestion | undefined {
			return questions[currentTab];
		}

		function optionCount(question: NormalizedQuestion): number {
			return question.type === "single" ? questionOptionsForSingle(question).length : question.options.length;
		}

		function getCursor(question: NormalizedQuestion): number {
			const max = Math.max(0, optionCount(question) - 1);
			const cursor = cursors.get(question.id) ?? defaultCursor(question);
			return clamp(cursor, 0, max);
		}

		function setCursor(question: NormalizedQuestion, cursor: number): void {
			const max = Math.max(0, optionCount(question) - 1);
			cursors.set(question.id, clamp(cursor, 0, max));
		}

		function buildAnswers(): QuestionAnswer[] {
			const answers: QuestionAnswer[] = [];
			for (const question of questions) {
				const state = getQuestionState(states, question);
				const answer = answerFromState(question, state, confirmedMultiIds);
				if (answer) answers.push(answer);
			}
			return answers;
		}

		function questionAnswered(question: NormalizedQuestion): boolean {
			const state = getQuestionState(states, question);
			return answerFromState(question, state, confirmedMultiIds) !== undefined;
		}

		function allAnswered(): boolean {
			return questions.every(questionAnswered);
		}

		function submit(cancelled: boolean): void {
			done({ questions, answers: cancelled ? [] : buildAnswers(), cancelled: cancelled || undefined });
		}

		function advanceAfterAnswer(): void {
			message = undefined;
			if (!isBatch) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = submitTabIndex;
			refresh();
		}

		function saveSingleOption(question: NormalizedQuestion, selectedIndex: number): void {
			const state = getQuestionState(states, question);
			if (!isSingleState(state)) return;
			state.index = selectedIndex;
			state.customAnswer = undefined;
			advanceAfterAnswer();
		}

		function startCustomAnswer(question: NormalizedQuestion): void {
			const state = getQuestionState(states, question);
			inputQuestionId = question.id;
			message = undefined;
			editor.setText(isSingleState(state) ? state.customAnswer ?? "" : "");
			refresh();
		}

		editor.onSubmit = (value) => {
			const question = questions.find((candidate) => candidate.id === inputQuestionId);
			if (!question) return;
			const answer = value.trim();
			if (!answer) {
				message = "Type a custom answer before submitting.";
				refresh();
				return;
			}
			const state = getQuestionState(states, question);
			if (!isSingleState(state)) return;
			state.index = undefined;
			state.customAnswer = answer;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function confirmSingle(question: NormalizedQuestion): void {
			const cursor = getCursor(question);
			const options = questionOptionsForSingle(question);
			const option = options[cursor];
			if (!option) return;
			if (option.isCustom) {
				startCustomAnswer(question);
				return;
			}
			saveSingleOption(question, cursor + 1);
		}

		function toggleMulti(question: NormalizedQuestion): void {
			const state = getQuestionState(states, question);
			if (!isMultiState(state)) return;
			const cursor = getCursor(question);
			message = undefined;
			if (state.selected.has(cursor)) {
				state.selected.delete(cursor);
				refresh();
				return;
			}
			if (question.maxSelections !== undefined && state.selected.size >= question.maxSelections) {
				message = `Maximum ${question.maxSelections} selection${question.maxSelections === 1 ? "" : "s"}.`;
				refresh();
				return;
			}
			state.selected.add(cursor);
			refresh();
		}

		function confirmMulti(question: NormalizedQuestion): void {
			const state = getQuestionState(states, question);
			if (!isMultiState(state)) return;
			if (!multiSelectionIsValid(question, state.selected)) {
				message = selectionSummary(question.minSelections ?? 1, question.maxSelections);
				refresh();
				return;
			}
			confirmedMultiIds.add(question.id);
			advanceAfterAnswer();
		}

		function moveTab(delta: number): void {
			if (!isBatch) return;
			currentTab = (currentTab + delta + totalTabs) % totalTabs;
			message = undefined;
			refresh();
		}

		function handleInput(data: string): void {
			if (inputQuestionId) {
				if (matchesBinding(keybindings, data, "tui.select.cancel", Key.escape)) {
					inputQuestionId = null;
					message = undefined;
					editor.setText("");
					refresh();
					return;
				}
				message = undefined;
				editor.handleInput(data);
				refresh();
				return;
			}

			if (isBatch) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					moveTab(1);
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					moveTab(-1);
					return;
				}
			}

			if (isBatch && currentTab === submitTabIndex) {
				if (matchesBinding(keybindings, data, "tui.select.confirm", Key.enter)) {
					if (allAnswered()) submit(false);
					else {
						message = `Answer ${questions.filter((question) => !questionAnswered(question)).map((question) => question.label).join(", ")} before submitting.`;
						refresh();
					}
					return;
				}
				if (matchesBinding(keybindings, data, "tui.select.cancel", Key.escape)) submit(true);
				return;
			}

			const question = currentQuestion();
			if (!question) return;
			const cursor = getCursor(question);

			if (matchesBinding(keybindings, data, "tui.select.up", Key.up)) {
				setCursor(question, cursor - 1);
				message = undefined;
				refresh();
				return;
			}
			if (matchesBinding(keybindings, data, "tui.select.down", Key.down)) {
				setCursor(question, cursor + 1);
				message = undefined;
				refresh();
				return;
			}
			if (matchesBinding(keybindings, data, "tui.select.pageUp", Key.pageUp)) {
				setCursor(question, cursor - SELECT_PAGE_STEP);
				message = undefined;
				refresh();
				return;
			}
			if (matchesBinding(keybindings, data, "tui.select.pageDown", Key.pageDown)) {
				setCursor(question, cursor + SELECT_PAGE_STEP);
				message = undefined;
				refresh();
				return;
			}
			if (question.type === "multi" && matchesKey(data, Key.space)) {
				toggleMulti(question);
				return;
			}
			if (matchesBinding(keybindings, data, "tui.select.confirm", Key.enter)) {
				if (question.type === "single") confirmSingle(question);
				else confirmMulti(question);
				return;
			}
			if (matchesBinding(keybindings, data, "tui.select.cancel", Key.escape)) submit(true);
		}

		function renderTabs(add: (line: string) => void): void {
			if (!isBatch) return;
			const tabs: string[] = [];
			for (let i = 0; i < questions.length; i++) {
				const question = questions[i];
				const isActive = i === currentTab;
				const answered = questionAnswered(question);
				const box = answered ? "■" : "□";
				const text = ` ${box} ${question.label} `;
				const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text);
				tabs.push(styled);
			}
			const submitText = " ✓ Submit ";
			const submitStyled = currentTab === submitTabIndex
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg(allAnswered() ? "success" : "dim", submitText);
			tabs.push(submitStyled);
			add(` ${tabs.join(" ")}`);
		}

		function renderSingleQuestion(add: (line: string) => void, question: NormalizedQuestion, width: number): void {
			const state = getQuestionState(states, question);
			const cursor = getCursor(question);
			const options = questionOptionsForSingle(question);
			const inputMode = inputQuestionId === question.id;
			for (let i = 0; i < options.length; i++) {
				const option = options[i];
				const isCursor = i === cursor;
				const isSelected = isSingleState(state) && (state.index === i + 1 || (option.isCustom && state.customAnswer !== undefined));
				const pointer = isCursor ? theme.fg("accent", "> ") : "  ";
				const radio = isSelected ? theme.fg("success", "(●)") : theme.fg("dim", "( )");
				const color = isCursor ? "accent" : "text";
				const recommended = question.recommendedIndex === i + 1 ? theme.fg("success", " [recommended]") : "";
				const customPreview = option.isCustom && isSingleState(state) && state.customAnswer ? theme.fg("muted", ` — ${state.customAnswer}`) : "";
				const editMarker = option.isCustom && inputMode ? " ✎" : "";
				add(`${pointer}${radio} ${theme.fg(color, `${i + 1}. ${option.label}${editMarker}`)}${recommended}${customPreview}`);
				if (option.description) add(`      ${theme.fg("muted", option.description)}`);
			}
			if (inputMode) {
				add("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
			}
		}

		function renderMultiQuestion(add: (line: string) => void, question: NormalizedQuestion): void {
			const state = getQuestionState(states, question);
			if (!isMultiState(state)) return;
			const cursor = getCursor(question);
			for (let i = 0; i < question.options.length; i++) {
				const option = question.options[i];
				const checked = state.selected.has(i);
				const isCursor = i === cursor;
				const pointer = isCursor ? theme.fg("accent", "> ") : "  ";
				const box = checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const color = isCursor ? "accent" : "text";
				add(`${pointer}${box} ${theme.fg(color, `${i + 1}. ${option.label}`)}`);
				if (option.description) add(`      ${theme.fg("muted", option.description)}`);
			}
			add("");
			const valid = multiSelectionIsValid(question, state.selected);
			const answered = confirmedMultiIds.has(question.id) && valid;
			const status = `${state.selected.size} selected. ${selectionSummary(question.minSelections ?? 1, question.maxSelections)}${answered ? " Answered." : ""}`;
			add(theme.fg(valid ? "dim" : "warning", ` ${status}`));
		}

		function renderSubmitTab(add: (line: string) => void): void {
			add(theme.fg("accent", theme.bold(" Ready to submit")));
			add("");
			for (const question of questions) {
				const state = getQuestionState(states, question);
				const answer = answerFromState(question, state, confirmedMultiIds);
				if (!answer) {
					add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("warning", "unanswered")}`);
					continue;
				}
				const value = answer.type === "single"
					? `${answer.isCustom ? "(custom) " : answer.indexes[0] ? `${answer.indexes[0]}. ` : ""}${answer.labels[0] ?? ""}`
					: answer.labels.length > 0
						? answer.labels.map((label, index) => `${answer.indexes[index]}. ${label}`).join(", ")
						: "(none)";
				add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", value)}`);
			}
			add("");
			if (allAnswered()) add(theme.fg("success", " Press Enter to submit"));
			else add(theme.fg("warning", " Answer all questions before submitting"));
		}

		function render(width: number): string[] {
			if (cache.cachedLines && cache.cachedWidth === width) return cache.cachedLines;

			const lines: string[] = [];
			const add = (line: string) => lines.push(truncateToWidth(line, width));

			add(borderLine(theme, width));
			renderTabs(add);
			if (isBatch) lines.push("");

			if (isBatch && currentTab === submitTabIndex) {
				renderSubmitTab(add);
			} else {
				const question = currentQuestion();
				if (question) {
					addIntroLines(add, theme, question.context, question.question);
					lines.push("");
					if (question.type === "single") renderSingleQuestion(add, question, width);
					else renderMultiQuestion(add, question);
				}
			}

			lines.push("");
			if (message) add(theme.fg("warning", ` ${message}`));
			if (!inputQuestionId) {
				const question = currentQuestion();
				const help = isBatch
					? currentTab === submitTabIndex
						? " Tab/←→ navigate • Enter submit • Esc cancel"
						: question?.type === "multi"
							? " Tab/←→ navigate • ↑↓ select • Space toggle • Enter confirm • Esc cancel"
							: " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
					: question?.type === "multi"
						? " ↑↓ navigate • Space toggle • Enter submit • Esc cancel"
						: " ↑↓ navigate • Enter select • Esc cancel";
				add(theme.fg("dim", help));
			} else {
				add(theme.fg("dim", " Enter submit • Esc back to options"));
			}
			add(borderLine(theme, width));

			cache.cachedWidth = width;
			cache.cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => invalidateCache(cache),
			handleInput,
		};
	});
}

function isNewDetails(details: unknown): details is AskQuestionDetails {
	return isRecord(details) && Array.isArray(details.questions) && Array.isArray(details.answers);
}

function isLegacySingleDetails(details: unknown): details is LegacySingleQuestionDetails {
	return isRecord(details) && typeof details.question === "string" && Array.isArray(details.options) && !Array.isArray(details.answers);
}

function isLegacyMultiDetails(details: unknown): details is LegacyMultiQuestionDetails {
	return isRecord(details) && typeof details.question === "string" && Array.isArray(details.answers) && Array.isArray(details.selectedIndexes);
}

function renderOptionLabel(option: unknown, index: number): string {
	if (typeof option === "string") return `${index + 1}. ${option}`;
	if (isRecord(option)) return `${index + 1}. ${String(option.label ?? option.value ?? "")}`;
	return `${index + 1}. ${String(option)}`;
}

function summarizeCallArgs(args: unknown): { count: number; labels: string[]; question?: string; options: unknown[] } {
	if (isRecord(args) && Array.isArray(args.questions)) {
		const labels = args.questions.map((raw, index) => {
			if (!isRecord(raw)) return `Q${index + 1}`;
			return String(raw.label ?? raw.id ?? `Q${index + 1}`);
		});
		const first = isRecord(args.questions[0]) ? String(args.questions[0].question ?? "") : undefined;
		const options = isRecord(args.questions[0]) && Array.isArray(args.questions[0].options) ? args.questions[0].options : [];
		return { count: args.questions.length, labels, question: first, options };
	}
	if (isRecord(args)) {
		const options = Array.isArray(args.options) ? args.options : [];
		return { count: 1, labels: ["Q1"], question: String(args.question ?? ""), options };
	}
	return { count: 0, labels: [], options: [] };
}

export default function questions(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: `Ask the user one to ${MAX_QUESTIONS} single-choice or multi-select questions with selectable options. Single-choice questions always include a custom answer option. Use whenever you need user input, not only during planning.`,
		promptSnippet: `Ask the user up to ${MAX_QUESTIONS} typed questions (single-choice always includes custom answer, or multi-select)`,
		promptGuidelines: [
			"Use ask_question when you need user decisions, preferences, confirmations, or clarifications before proceeding.",
			"Use ask_question for both single-choice and multi-select questions by setting each question's type to \"single\" or \"multi\".",
			"Do not add your own custom/other option for single-choice questions; ask_question always shows a custom answer option automatically.",
			`Batch related questions in one ask_question call when there are ${MAX_QUESTIONS} or fewer; otherwise ask only the highest-impact questions first.`,
		],
		parameters: AskQuestionParams,
		prepareArguments: prepareAskQuestionArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params);

			if (!ctx.hasUI) return chatFallbackResult(questions);

			const result = await askQuestionnaire(ctx, questions);
			if (result === undefined) return chatFallbackResult(questions);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "The user dismissed the question dialog. Ask for the answer in chat and wait for their response." }],
					details: result,
				};
			}

			const answers = result.answers;
			return {
				content: [{ type: "text", text: answers.map(answerSummary).join("\n") || "No answers were provided." }],
				details: { questions, answers } satisfies AskQuestionDetails,
			};
		},
		renderCall(args, theme) {
			const summary = summarizeCallArgs(args);
			let text = theme.fg("toolTitle", theme.bold("ask_question "));
			if (summary.count > 1) {
				text += theme.fg("muted", `${summary.count} questions`);
				if (summary.labels.length > 0) text += theme.fg("dim", ` (${summary.labels.join(", ")})`);
			} else {
				text += theme.fg("muted", summary.question ?? "1 question");
			}
			if (summary.options.length > 0) {
				text += `\n${theme.fg("dim", `  Options: ${summary.options.map(renderOptionLabel).join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (isNewDetails(details)) {
				if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
				if (details.needsChatQuestion) return new Text(theme.fg("muted", "Needs chat answer"), 0, 0);
				if (details.answers.length === 0) return new Text(theme.fg("muted", "No answers"), 0, 0);
				const lines = details.answers.map((answer) => `${theme.fg("success", answer.type === "multi" ? "☑ " : "✓ ")}${theme.fg("accent", answerSummary(answer))}`);
				return new Text(lines.join("\n"), 0, 0);
			}

			if (isLegacyMultiDetails(details)) {
				if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
				if (details.needsChatQuestion) return new Text(theme.fg("muted", "Needs chat answer"), 0, 0);
				const lines = details.answers.map((answer, index) => {
					const selectedIndex = details.selectedIndexes[index];
					return `${theme.fg("success", "☑ ")}${theme.fg("accent", `${selectedIndex}. ${answer}`)}`;
				});
				return new Text(lines.length > 0 ? lines.join("\n") : theme.fg("muted", "No answers selected"), 0, 0);
			}

			if (isLegacySingleDetails(details)) {
				if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
				if (!details.answer) return new Text(theme.fg("muted", details.needsChatQuestion ? "Needs chat answer" : "No answer"), 0, 0);
				const prefix = details.choice === "custom" ? "(custom) " : details.choice ? `${details.choice}. ` : "";
				return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `${prefix}${details.answer}`), 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}
