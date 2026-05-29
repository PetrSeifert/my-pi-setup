import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const RUN_RETENTION = 20;
const VIEWER_NOTIFY_THROTTLE_MS = 50;
const PREVIEW_TEXT_LIMIT = 60_000;
const COLLAPSED_TOOL_TEXT_LIMIT = 800;
const EXPANDED_TOOL_TEXT_LIMIT = 8_000;
const DETAILS_TEXT_LIMIT = 20_000;
const THINKING_TEXT_LIMIT = 8_000;

const taskSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Stable caller-provided task id" }),
  ),
  task: Type.String({ description: "The full task for the sub-agent" }),
  role: Type.Optional(
    Type.String({
      description: "Specialized role/persona, e.g. code reviewer, test analyst",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Additional sub-agent instructions" }),
  ),
});

const delegateTasksSchema = Type.Object({
  tasks: Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS }),
  concurrency: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_CONCURRENCY,
      default: DEFAULT_CONCURRENCY,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1000,
      maximum: MAX_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional provider/model pattern for sub-agents",
    }),
  ),
  thinkingLevel: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const),
  ),
});

type DelegateTasksInput = Static<typeof delegateTasksSchema>;
type TaskSpec = Static<typeof taskSchema>;

type TaskStatus = "success" | "error" | "cancelled" | "timeout";
type TaskRunStatus = "queued" | "running" | TaskStatus;
type RunStatus = "running" | TaskStatus;

interface TaskResult {
  id: string;
  task: string;
  status: TaskStatus;
  answer?: string;
  error?: string;
  durationMs: number;
  model?: string;
}

interface ThinkingBlockState {
  key: string;
  messageSeq: number;
  contentIndex: number;
  text: string;
  signature?: string;
  redacted?: boolean;
  updatedAt: number;
}

interface AssistantToolCallState {
  key: string;
  messageSeq: number;
  contentIndex: number;
  id?: string;
  name?: string;
  arguments?: unknown;
  delta?: string;
  updatedAt: number;
}

interface SubagentToolEventState {
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  status: "running" | "success" | "error";
  startedAt: number;
  endedAt?: number;
  partialContentPreview?: string;
  partialDetailsPreview?: string;
  resultContentPreview?: string;
  resultDetailsPreview?: string;
  error?: string;
}

interface SubagentTaskState {
  index: number;
  id: string;
  spec: TaskSpec;
  status: TaskRunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  timeoutMs: number;
  modelPattern?: string;
  thinkingLevel?: ThinkingLevel;
  model?: string;
  sessionManager?: SessionManager;
  sessionId?: string;
  messages: AgentMessage[];
  latestStreamingMessage?: AgentMessage;
  assistantText: string;
  latestAssistantText: string;
  finalAnswer?: string;
  error?: string;
  lastEventAt?: number;
  currentAssistantSeq?: number;
  assistantSeq: number;
  thinkingBlocks: Map<string, ThinkingBlockState>;
  assistantToolCalls: Map<string, AssistantToolCallState>;
  toolEvents: SubagentToolEventState[];
}

interface SubagentRunState {
  ordinal: number;
  runId: string;
  parentToolCallId: string;
  status: RunStatus;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  concurrency: number;
  timeoutMs: number;
  modelPattern?: string;
  thinkingLevel?: ThinkingLevel;
  tasks: SubagentTaskState[];
  error?: string;
}

type ViewerNode =
  | { type: "main" }
  | { type: "run"; run: SubagentRunState }
  | { type: "task"; run: SubagentRunState; task: SubagentTaskState };

const subagentRuns: SubagentRunState[] = [];
const activeViewerCallbacks = new Set<() => void>();
let runSequence = 0;
let viewerNotifyTimer: ReturnType<typeof setTimeout> | undefined;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_tasks",
    label: "Delegate Tasks",
    description:
      "Run independent read-only tasks in isolated in-process pi sub-agents and return their final answers.",
    promptSnippet:
      "Run one or more independent read-only sub-agent investigations concurrently",
    promptGuidelines: [
      "Use delegate_tasks for parallel research, code review, test analysis, design comparison, and independent repository investigation.",
      "Do not use delegate_tasks for work that requires immediate file mutation; sub-agents are read-only by default.",
      "Give delegate_tasks complete, independent task descriptions, including relevant paths and expected output.",
    ],
    parameters: delegateTasksSchema,
    async execute(
      toolCallId,
      params: DelegateTasksInput,
      signal,
      onUpdate,
      ctx,
    ) {
      const tasks = params.tasks.slice(0, MAX_TASKS);
      const concurrency = clamp(
        Math.floor(params.concurrency ?? DEFAULT_CONCURRENCY),
        1,
        MAX_CONCURRENCY,
      );
      const timeoutMs = clamp(
        Math.floor(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        1000,
        MAX_TIMEOUT_MS,
      );
      const runState = createRunState(
        toolCallId,
        tasks,
        concurrency,
        timeoutMs,
        params.model,
        params.thinkingLevel,
      );

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Starting ${tasks.length} sub-agent task(s), concurrency ${concurrency}...`,
          },
        ],
        details: {},
      });

      try {
        const results = await promisePool(
          runState.tasks,
          concurrency,
          async (taskState) => {
            if (signal?.aborted) {
              markTaskStarted(taskState);
              markTaskFinal(taskState, "cancelled", {
                error: "Parent delegate_tasks execution was cancelled before this task started.",
              });
              notifyRegistryChanged();
              return taskResultFromState(taskState);
            }

            onUpdate?.({
              content: [
                { type: "text", text: `Sub-agent ${taskState.id} running...` },
              ],
              details: {},
            });
            const result = await runSubAgentTask(
              taskState.spec,
              taskState.id,
              ctx,
              {
                model: params.model,
                thinkingLevel: params.thinkingLevel,
                timeoutMs,
              },
              signal,
              taskState,
            );
            onUpdate?.({
              content: [
                { type: "text", text: `Sub-agent ${taskState.id} ${result.status}.` },
              ],
              details: {},
            });
            return result;
          },
        );

        runState.status = summarizeRunStatus(results, signal);
        runState.endedAt = Date.now();
        pruneCompletedRuns();
        notifyRegistryChanged();

        const markdownSummary = formatResults(results);
        return {
          content: [{ type: "text", text: markdownSummary }],
          details: { results },
        };
      } catch (error) {
        const status: RunStatus = signal?.aborted ? "cancelled" : "error";
        runState.status = status;
        runState.error = error instanceof Error ? error.message : String(error);
        runState.endedAt = Date.now();
        for (const taskState of runState.tasks) {
          if (!isFinalTaskStatus(taskState.status)) {
            if (taskState.status === "queued") markTaskStarted(taskState);
            markTaskFinal(taskState, status === "cancelled" ? "cancelled" : "error", {
              error: runState.error,
            });
          }
        }
        pruneCompletedRuns();
        notifyRegistryChanged();
        throw error;
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect live and completed delegate_tasks sub-agents",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!ctx.hasUI) {
        ctx.ui.notify(formatRegistrySummary(), "info");
        return;
      }

      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) =>
            new SubagentsViewer(tui, theme, () => done(undefined), target),
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
        ctx.ui.notify(`Sub-agent viewer unavailable: ${message}\n${formatRegistrySummary()}`, "warning");
      }
    },
  });

  pi.registerCommand("subagent-test", {
    description: "Smoke test the delegate_tasks extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Ask the agent to call delegate_tasks with: summarize the top-level files in this repo. Use /subagents to inspect live tasks.",
        "info",
      );
    },
  });
}

async function runSubAgentTask(
  task: TaskSpec,
  id: string,
  ctx: ExtensionContext,
  options: { model?: string; thinkingLevel?: ThinkingLevel; timeoutMs: number },
  parentSignal: AbortSignal | undefined,
  taskState: SubagentTaskState,
): Promise<TaskResult> {
  const started = Date.now();
  markTaskStarted(taskState);
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    options.timeoutMs,
  );
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  let timedOut = false;
  const onTimeout = () => {
    timedOut = true;
    void session?.abort();
  };
  const onParentAbort = () => {
    void session?.abort();
  };
  timeoutController.signal.addEventListener("abort", onTimeout, { once: true });
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    if (parentSignal?.aborted) {
      throw new Error("Parent delegate_tasks execution was cancelled.");
    }

    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
    });
    await loader.reload();
    if (timeoutController.signal.aborted || parentSignal?.aborted) {
      throw new Error(parentSignal?.aborted ? "Cancelled" : "Timed out");
    }

    const model = options.model ? resolveModel(options.model, ctx) : ctx.model;
    taskState.model = model ? `${model.provider}/${model.id}` : undefined;
    taskState.modelPattern = options.model;
    taskState.thinkingLevel = options.thinkingLevel;
    notifyRegistryChanged();

    const childSessionManager = SessionManager.inMemory(ctx.cwd);
    childSessionManager.appendSessionInfo(`sub-agent ${id}`);
    taskState.sessionManager = childSessionManager;

    ({ session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model,
      thinkingLevel: options.thinkingLevel,
      modelRegistry: ctx.modelRegistry,
      resourceLoader: loader,
      sessionManager: childSessionManager,
      settingsManager,
      tools: READ_ONLY_TOOLS,
    }));
    taskState.sessionId = session.sessionId;
    subscribeToSubAgentSession(session, taskState);
    notifyRegistryChanged();

    if (timeoutController.signal.aborted || parentSignal?.aborted) {
      throw new Error(parentSignal?.aborted ? "Cancelled" : "Timed out");
    }

    await session.prompt(buildPrompt(task), { source: "extension" });

    if (timedOut || parentSignal?.aborted) {
      const status: TaskStatus = parentSignal?.aborted ? "cancelled" : "timeout";
      const error =
        status === "timeout"
          ? `Timed out after ${options.timeoutMs}ms.`
          : "Parent delegate_tasks execution was cancelled.";
      markTaskFinal(taskState, status, { error, model: taskState.model });
      return taskResultFromState(taskState);
    }

    const answer =
      (taskState.assistantText.trim() || extractLastAssistantText(taskState.messages).trim()) ||
      "(no assistant text captured)";
    markTaskFinal(taskState, "success", { answer, model: taskState.model });
    return {
      id,
      task: task.task,
      status: "success",
      answer,
      durationMs: Date.now() - started,
      model: taskState.model,
    };
  } catch (error) {
    const status: TaskStatus = parentSignal?.aborted
      ? "cancelled"
      : timedOut
        ? "timeout"
        : "error";
    const message =
      status === "timeout"
        ? `Timed out after ${options.timeoutMs}ms.`
        : status === "cancelled"
          ? "Parent delegate_tasks execution was cancelled."
          : error instanceof Error
            ? error.message
            : String(error);
    markTaskFinal(taskState, status, { error: message, model: taskState.model });
    return {
      id,
      task: task.task,
      status,
      error: message,
      durationMs: Date.now() - started,
      model: taskState.model,
    };
  } finally {
    clearTimeout(timeout);
    timeoutController.signal.removeEventListener("abort", onTimeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
    session?.dispose();
    notifyRegistryChanged();
  }
}

function subscribeToSubAgentSession(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  taskState: SubagentTaskState,
): void {
  session.subscribe((event) => {
    taskState.lastEventAt = Date.now();

    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          taskState.currentAssistantSeq = ++taskState.assistantSeq;
        }
        break;
      }
      case "message_update": {
        if (event.message.role === "assistant") {
          const seq = taskState.currentAssistantSeq ?? ++taskState.assistantSeq;
          taskState.currentAssistantSeq = seq;
          updateAssistantSnapshot(taskState, event.message, seq);
          taskState.latestStreamingMessage = event.message;
          taskState.latestAssistantText = extractAssistantText(event.message);

          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta") {
            taskState.assistantText += assistantEvent.delta;
          } else if (assistantEvent.type === "toolcall_delta") {
            const key = `${seq}:${assistantEvent.contentIndex}`;
            const current: AssistantToolCallState = taskState.assistantToolCalls.get(key) ?? {
              key,
              messageSeq: seq,
              contentIndex: assistantEvent.contentIndex,
              updatedAt: Date.now(),
            };
            current.delta = `${current.delta ?? ""}${assistantEvent.delta}`;
            current.updatedAt = Date.now();
            taskState.assistantToolCalls.set(key, current);
          }
        }
        notifyRegistryChanged();
        break;
      }
      case "message_end": {
        taskState.messages.push(event.message);
        if (event.message.role === "assistant") {
          const seq = taskState.currentAssistantSeq ?? ++taskState.assistantSeq;
          updateAssistantSnapshot(taskState, event.message, seq);
          taskState.latestAssistantText = extractAssistantText(event.message);
          if (!taskState.assistantText.trim()) {
            taskState.assistantText = taskState.latestAssistantText;
          }
          taskState.currentAssistantSeq = undefined;
        }
        notifyRegistryChanged();
        break;
      }
      case "tool_execution_start": {
        const existing = taskState.toolEvents.find(
          (tool) => tool.toolCallId === event.toolCallId,
        );
        if (existing) {
          existing.status = "running";
          existing.argsPreview = previewValue(event.args);
          existing.startedAt = Date.now();
          existing.endedAt = undefined;
          existing.error = undefined;
        } else {
          taskState.toolEvents.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsPreview: previewValue(event.args),
            status: "running",
            startedAt: Date.now(),
          });
        }
        notifyRegistryChanged();
        break;
      }
      case "tool_execution_update": {
        const tool = getOrCreateToolEvent(taskState, event.toolCallId, event.toolName, event.args);
        tool.partialContentPreview = previewToolContent(event.partialResult);
        tool.partialDetailsPreview = previewToolDetails(event.partialResult);
        notifyRegistryChanged();
        break;
      }
      case "tool_execution_end": {
        const tool = getOrCreateToolEvent(taskState, event.toolCallId, event.toolName, undefined);
        tool.status = event.isError ? "error" : "success";
        tool.endedAt = Date.now();
        tool.resultContentPreview = previewToolContent(event.result);
        tool.resultDetailsPreview = previewToolDetails(event.result);
        if (event.isError) {
          tool.error = tool.resultContentPreview || tool.resultDetailsPreview || "Tool failed";
        }
        notifyRegistryChanged();
        break;
      }
      default:
        break;
    }
  });
}

function updateAssistantSnapshot(
  taskState: SubagentTaskState,
  message: AgentMessage,
  messageSeq: number,
): void {
  if (message.role !== "assistant") return;
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index] as any;
    const key = `${messageSeq}:${index}`;
    if (block?.type === "thinking") {
      taskState.thinkingBlocks.set(key, {
        key,
        messageSeq,
        contentIndex: index,
        text: typeof block.thinking === "string" ? block.thinking : "",
        signature: typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined,
        redacted: block.redacted === true,
        updatedAt: Date.now(),
      });
    } else if (block?.type === "toolCall") {
      taskState.assistantToolCalls.set(key, {
        key,
        messageSeq,
        contentIndex: index,
        id: typeof block.id === "string" ? block.id : undefined,
        name: typeof block.name === "string" ? block.name : undefined,
        arguments: block.arguments,
        updatedAt: Date.now(),
      });
    }
  }
}

function getOrCreateToolEvent(
  taskState: SubagentTaskState,
  toolCallId: string,
  toolName: string,
  args: unknown,
): SubagentToolEventState {
  let tool = taskState.toolEvents.find((entry) => entry.toolCallId === toolCallId);
  if (!tool) {
    tool = {
      toolCallId,
      toolName,
      argsPreview: previewValue(args),
      status: "running",
      startedAt: Date.now(),
    };
    taskState.toolEvents.push(tool);
  } else if (args !== undefined) {
    tool.argsPreview = previewValue(args);
  }
  return tool;
}

function createRunState(
  parentToolCallId: string,
  tasks: TaskSpec[],
  concurrency: number,
  timeoutMs: number,
  modelPattern: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): SubagentRunState {
  const ordinal = ++runSequence;
  const now = Date.now();
  const run: SubagentRunState = {
    ordinal,
    runId: `run-${ordinal}`,
    parentToolCallId,
    status: "running",
    createdAt: now,
    startedAt: now,
    concurrency,
    timeoutMs,
    modelPattern,
    thinkingLevel,
    tasks: tasks.map((task, index) => ({
      index,
      id: task.id ?? `task-${index + 1}`,
      spec: task,
      status: "queued",
      createdAt: now,
      timeoutMs,
      modelPattern,
      thinkingLevel,
      messages: [],
      assistantText: "",
      latestAssistantText: "",
      assistantSeq: 0,
      thinkingBlocks: new Map(),
      assistantToolCalls: new Map(),
      toolEvents: [],
    })),
  };
  subagentRuns.push(run);
  notifyRegistryChanged();
  return run;
}

function markTaskStarted(taskState: SubagentTaskState): void {
  if (!taskState.startedAt) taskState.startedAt = Date.now();
  taskState.status = "running";
  taskState.lastEventAt = Date.now();
  notifyRegistryChanged();
}

function markTaskFinal(
  taskState: SubagentTaskState,
  status: TaskStatus,
  options: { answer?: string; error?: string; model?: string } = {},
): void {
  taskState.status = status;
  taskState.endedAt = Date.now();
  taskState.lastEventAt = taskState.endedAt;
  if (options.answer !== undefined) taskState.finalAnswer = options.answer;
  if (options.error !== undefined) taskState.error = options.error;
  if (options.model !== undefined) taskState.model = options.model;
  notifyRegistryChanged();
}

function taskResultFromState(taskState: SubagentTaskState): TaskResult {
  const status = isFinalTaskStatus(taskState.status) ? taskState.status : "cancelled";
  const durationMs =
    (taskState.endedAt ?? Date.now()) - (taskState.startedAt ?? taskState.createdAt);
  return {
    id: taskState.id,
    task: taskState.spec.task,
    status,
    answer: status === "success" ? taskState.finalAnswer : undefined,
    error: status === "success" ? undefined : taskState.error,
    durationMs,
    model: taskState.model,
  };
}

function summarizeRunStatus(results: TaskResult[], signal?: AbortSignal): RunStatus {
  if (signal?.aborted) return "cancelled";
  if (results.every((result) => result.status === "success")) return "success";
  if (results.some((result) => result.status === "timeout")) return "timeout";
  if (results.some((result) => result.status === "cancelled")) return "cancelled";
  return "error";
}

function pruneCompletedRuns(): void {
  const completed = subagentRuns.filter((run) => run.status !== "running");
  while (completed.length > RUN_RETENTION) {
    const oldest = completed.shift();
    if (!oldest) break;
    const index = subagentRuns.indexOf(oldest);
    if (index >= 0) subagentRuns.splice(index, 1);
  }
}

function addViewerCallback(callback: () => void): () => void {
  activeViewerCallbacks.add(callback);
  return () => {
    activeViewerCallbacks.delete(callback);
  };
}

function notifyRegistryChanged(): void {
  if (activeViewerCallbacks.size === 0) return;
  if (viewerNotifyTimer) return;
  viewerNotifyTimer = setTimeout(() => {
    viewerNotifyTimer = undefined;
    for (const callback of activeViewerCallbacks) {
      try {
        callback();
      } catch {
        // Ignore stale viewer callbacks.
      }
    }
  }, VIEWER_NOTIFY_THROTTLE_MS);
}

class SubagentsViewer implements Component {
  private selectedIndex = 0;
  private treeScroll = 0;
  private detailScroll = 0;
  private showThinking = false;
  private showToolDetails = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    target: string,
  ) {
    this.unsubscribe = addViewerCallback(() => {
      this.invalidate();
      this.tui.requestRender();
    });
    this.selectedIndex = this.initialSelection(target);
  }

  handleInput(data: string): void {
    const nodes = flattenViewerNodes();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }

    if (matchesKey(data, "up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = Math.min(Math.max(0, nodes.length - 1), this.selectedIndex + 1);
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "left")) {
      this.detailScroll = Math.max(0, this.detailScroll - 6);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "right")) {
      this.detailScroll += 6;
      this.tui.requestRender();
      return;
    }
    if (data === "t" || data === "T") {
      this.showThinking = !this.showThinking;
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "o" || data === "O" || matchesKey(data, "ctrl+o")) {
      this.showToolDetails = !this.showToolDetails;
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(30, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const termRows = this.tui.terminal?.rows ?? 32;
    const maxBodyRows = Math.max(10, Math.floor(termRows * 0.88) - 2);
    const nodes = flattenViewerNodes();
    this.clampSelection(nodes);
    const selectedNode = nodes[this.selectedIndex] ?? { type: "main" as const };

    const body: string[] = [];
    body.push(this.padContentLine(this.summaryLine(), innerWidth));
    body.push(
      this.padContentLine(
        this.theme.fg(
          "dim",
          "↑/↓ select • PgUp/PgDn or ←/→ scroll • t thinking • o tool output • Esc close",
        ),
        innerWidth,
      ),
    );
    body.push(this.theme.fg("border", "─".repeat(innerWidth)));

    const contentRows = Math.max(6, maxBodyRows - body.length - 1);
    if (innerWidth >= 98) {
      body.push(...this.renderWide(nodes, selectedNode, innerWidth, contentRows));
    } else {
      body.push(...this.renderNarrow(nodes, selectedNode, innerWidth, contentRows));
    }

    return this.frame(body.slice(0, maxBodyRows), safeWidth, "Sub-agents");
  }

  invalidate(): void {
    // Stateless render; live data is read directly from module state.
  }

  dispose(): void {
    this.unsubscribe();
  }

  private renderWide(
    nodes: ViewerNode[],
    selectedNode: ViewerNode,
    width: number,
    rows: number,
  ): string[] {
    const treeWidth = clamp(Math.floor(width * 0.38), 34, 52);
    const separator = this.theme.fg("border", "│");
    const detailWidth = Math.max(20, width - treeWidth - visibleWidth(separator));
    const treeLines = this.visibleTreeLines(nodes, treeWidth, rows);
    const detailLines = this.visibleDetailLines(selectedNode, detailWidth, rows);
    const lineCount = Math.max(treeLines.length, detailLines.length, rows);
    const result: string[] = [];

    for (let i = 0; i < lineCount; i++) {
      const left = this.padContentLine(treeLines[i] ?? "", treeWidth);
      const right = this.padContentLine(detailLines[i] ?? "", detailWidth);
      result.push(truncateToWidth(left + separator + right, width, "", true));
    }
    return result;
  }

  private renderNarrow(
    nodes: ViewerNode[],
    selectedNode: ViewerNode,
    width: number,
    rows: number,
  ): string[] {
    const treeRows = clamp(Math.floor(rows * 0.35), 4, Math.min(10, rows - 3));
    const detailRows = Math.max(3, rows - treeRows - 1);
    const result: string[] = [];
    result.push(...this.visibleTreeLines(nodes, width, treeRows));
    result.push(this.theme.fg("border", "─".repeat(width)));
    result.push(...this.visibleDetailLines(selectedNode, width, detailRows));
    return result.slice(0, rows);
  }

  private visibleTreeLines(nodes: ViewerNode[], width: number, rows: number): string[] {
    this.clampTreeScroll(nodes, rows);
    const all = buildTreeLines(nodes, this.selectedIndex, width, this.theme);
    const visible = all.slice(this.treeScroll, this.treeScroll + rows);
    while (visible.length < rows) visible.push("");
    return visible;
  }

  private visibleDetailLines(node: ViewerNode, width: number, rows: number): string[] {
    const all = buildDetailLines(node, width, this.theme, {
      showThinking: this.showThinking,
      showToolDetails: this.showToolDetails,
    });
    const hasOverflow = all.length > rows;
    const contentRows = hasOverflow ? Math.max(1, rows - 1) : rows;
    const maxScroll = Math.max(0, all.length - contentRows);
    this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
    const visible = all.slice(this.detailScroll, this.detailScroll + contentRows);
    if (hasOverflow) {
      const position = `${this.detailScroll + 1}-${Math.min(all.length, this.detailScroll + contentRows)}/${all.length}`;
      visible.push(
        this.padContentLine(
          this.theme.fg("dim", `… detail lines ${position} (←/→ or PgUp/PgDn)`),
          width,
        ),
      );
    }
    while (visible.length < rows) visible.push("");
    return visible;
  }

  private summaryLine(): string {
    const activeRuns = subagentRuns.filter((run) => run.status === "running").length;
    const activeTasks = subagentRuns.reduce(
      (count, run) => count + run.tasks.filter((task) => task.status === "running").length,
      0,
    );
    const completedRuns = subagentRuns.length - activeRuns;
    return `${this.theme.fg("accent", "delegate_tasks")} ${subagentRuns.length} run(s) • ${activeRuns} active run(s) • ${activeTasks} active task(s) • ${completedRuns} completed`;
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
      result.push(border("│") + this.padContentLine(line, innerWidth) + border("│"));
    }
    result.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return result.map((line) => truncateToWidth(normalizeTuiLine(line), width, "", true));
  }

  private padContentLine(line: string, width: number): string {
    return truncateToWidth(normalizeTuiLine(line), width, "...", true);
  }

  private clampSelection(nodes: ViewerNode[]): void {
    if (nodes.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, nodes.length - 1);
  }

  private clampTreeScroll(nodes: ViewerNode[], rows: number): void {
    this.clampSelection(nodes);
    if (this.selectedIndex < this.treeScroll) this.treeScroll = this.selectedIndex;
    if (this.selectedIndex >= this.treeScroll + rows) {
      this.treeScroll = Math.max(0, this.selectedIndex - rows + 1);
    }
    this.treeScroll = clamp(this.treeScroll, 0, Math.max(0, nodes.length - rows));
  }

  private initialSelection(target: string): number {
    const nodes = flattenViewerNodes();
    if (!target) return 0;
    const normalized = target.toLowerCase();
    if (normalized === "last") return nodes.length > 1 ? 1 : 0;
    const index = nodes.findIndex((node) => {
      if (node.type === "run") {
        return node.run.runId.toLowerCase() === normalized || String(node.run.ordinal) === normalized;
      }
      if (node.type === "task") {
        return node.task.id.toLowerCase() === normalized;
      }
      return false;
    });
    return index >= 0 ? index : 0;
  }
}

function flattenViewerNodes(): ViewerNode[] {
  const nodes: ViewerNode[] = [{ type: "main" }];
  const runs = [...subagentRuns].reverse();
  for (const run of runs) {
    nodes.push({ type: "run", run });
    for (const task of run.tasks) nodes.push({ type: "task", run, task });
  }
  return nodes;
}

function buildTreeLines(
  nodes: ViewerNode[],
  selectedIndex: number,
  width: number,
  theme: Theme,
): string[] {
  if (nodes.length === 1 && nodes[0]?.type === "main") {
    return [
      treeLine("Main agent (current session)", 0, true, width, theme, ""),
      treeLine("(no delegate_tasks runs yet)", 1, false, width, theme, ""),
    ];
  }

  const lines: string[] = [];
  const runs = [...subagentRuns].reverse();
  let nodeIndex = 0;
  lines.push(treeLine("Main agent (current session)", 0, selectedIndex === nodeIndex, width, theme, ""));
  nodeIndex++;
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex]!;
    const runLast = runIndex === runs.length - 1;
    const connector = runLast ? "└─" : "├─";
    const done = countDoneTasks(run);
    const label = `${connector} ${statusIcon(run.status)} delegate_tasks #${run.ordinal} · ${run.status} · ${done}/${run.tasks.length} done`;
    lines.push(treeLine(label, 0, selectedIndex === nodeIndex, width, theme, run.status));
    nodeIndex++;
    for (let taskIndex = 0; taskIndex < run.tasks.length; taskIndex++) {
      const task = run.tasks[taskIndex]!;
      const taskLast = taskIndex === run.tasks.length - 1;
      const taskPrefix = `${runLast ? "   " : "│  "}${taskLast ? "└─" : "├─"}`;
      const role = task.spec.role ? ` · ${task.spec.role}` : "";
      const label = `${taskPrefix} ${statusIcon(task.status)} ${task.id} · ${task.status}${role}`;
      lines.push(treeLine(label, 0, selectedIndex === nodeIndex, width, theme, task.status));
      nodeIndex++;
    }
  }
  return lines;
}

function treeLine(
  text: string,
  indent: number,
  selected: boolean,
  width: number,
  theme: Theme,
  status: string,
): string {
  const marker = selected ? "› " : "  ";
  const color = statusColor(status);
  const styledText = color ? theme.fg(color, text) : text;
  const line = `${marker}${"  ".repeat(indent)}${styledText}`;
  const padded = truncateToWidth(line, width, "...", true);
  return selected ? theme.bg("selectedBg", padded) : padded;
}

function buildDetailLines(
  node: ViewerNode,
  width: number,
  theme: Theme,
  options: { showThinking: boolean; showToolDetails: boolean },
): string[] {
  const lines: string[] = [];
  const add = (line = "") => lines.push(truncateToWidth(normalizeTuiLine(line), width, "..."));
  const addWrapped = (text: string, prefix = "") => {
    const safePrefix = normalizeTuiLine(prefix);
    const safeText = sanitizeUntrustedDisplayText(text || "");
    const available = Math.max(1, width - visibleWidth(safePrefix));
    for (const wrapped of wrapTextWithAnsi(safeText, available)) {
      lines.push(truncateToWidth(normalizeTuiLine(safePrefix + wrapped), width, "..."));
    }
  };
  const addSection = (title: string) => {
    if (lines.length > 0) add("");
    add(theme.fg("accent", theme.bold(title)));
  };

  if (node.type === "main") {
    addSection("Main agent");
    add(`Current session. Sub-agent state is kept in memory for this pi runtime only.`);
    add("");
    if (subagentRuns.length === 0) {
      add(theme.fg("dim", "No delegate_tasks runs have been observed yet."));
      add(theme.fg("dim", "Run a task, then reopen /subagents to inspect it."));
      return lines;
    }
    const activeRuns = subagentRuns.filter((run) => run.status === "running").length;
    add(`Runs: ${subagentRuns.length} total, ${activeRuns} active, ${subagentRuns.length - activeRuns} completed`);
    add(`Tasks: ${subagentRuns.reduce((sum, run) => sum + run.tasks.length, 0)} total`);
    addSection("Recent runs");
    for (const run of [...subagentRuns].reverse().slice(0, 12)) {
      add(`${statusIcon(run.status)} delegate_tasks #${run.ordinal} · ${run.status} · ${countDoneTasks(run)}/${run.tasks.length} done · ${formatElapsed(run.startedAt, run.endedAt)}`);
    }
    return lines;
  }

  if (node.type === "run") {
    const run = node.run;
    addSection(`delegate_tasks #${run.ordinal}`);
    add(`Run id: ${run.runId}`);
    add(`Parent tool call: ${run.parentToolCallId}`);
    add(`Status: ${run.status}`);
    add(`Started: ${formatTime(run.startedAt)} (${formatElapsed(run.startedAt, run.endedAt)})`);
    add(`Concurrency: ${run.concurrency} · Timeout: ${run.timeoutMs}ms`);
    add(`Model: ${run.modelPattern ?? "parent model"}`);
    add(`Thinking: ${run.thinkingLevel ?? "parent/default"}`);
    if (run.error) addWrapped(limitText(run.error, DETAILS_TEXT_LIMIT), "Error: ");
    addSection("Tasks");
    for (const task of run.tasks) {
      const role = task.spec.role ? ` · ${task.spec.role}` : "";
      const model = task.model ? ` · ${task.model}` : "";
      add(`${statusIcon(task.status)} ${task.id} · ${task.status}${role}${model} · ${formatElapsed(task.startedAt ?? task.createdAt, task.endedAt)}`);
      if (task.error) addWrapped(limitText(task.error, 500), "  error: ");
      else if (task.finalAnswer) addWrapped(limitText(oneLine(task.finalAnswer), 500), "  answer: ");
    }
    return lines;
  }

  const { task, run } = node;
  addSection(`${task.id} · ${task.status}`);
  add(`Run: delegate_tasks #${run.ordinal} (${run.runId})`);
  add(`Role: ${task.spec.role ?? "(none)"}`);
  add(`Model: ${task.model ?? task.modelPattern ?? "parent model"}`);
  add(`Thinking: ${task.thinkingLevel ?? "parent/default"}`);
  add(`Started: ${task.startedAt ? formatTime(task.startedAt) : "queued"}`);
  add(`Elapsed: ${formatElapsed(task.startedAt ?? task.createdAt, task.endedAt)} · Timeout: ${task.timeoutMs}ms`);
  if (task.sessionId) add(`Child session: ${task.sessionId} (in memory)`);

  addSection("Task prompt");
  addWrapped(limitText(task.spec.task, DETAILS_TEXT_LIMIT));
  if (task.spec.systemPrompt) {
    addSection("Additional system prompt");
    addWrapped(limitText(task.spec.systemPrompt, DETAILS_TEXT_LIMIT));
  }

  const thinkingBlocks = [...task.thinkingBlocks.values()].sort(compareBlocks);
  addSection("Thinking");
  if (thinkingBlocks.length === 0) {
    add(theme.fg("dim", "No textual thinking blocks captured."));
  } else if (!options.showThinking) {
    add(theme.fg("dim", `${thinkingBlocks.length} thinking block(s) hidden. Press t to show.`));
  } else {
    for (const block of thinkingBlocks) {
      if (block.redacted || (!block.text && block.signature)) {
        add(theme.fg("dim", `thinking #${block.messageSeq}.${block.contentIndex}: redacted/signature-only; not expanded.`));
        continue;
      }
      add(theme.fg("muted", `thinking #${block.messageSeq}.${block.contentIndex}`));
      addWrapped(limitText(block.text || "(empty thinking block)", THINKING_TEXT_LIMIT), "  ");
    }
  }

  addSection("Assistant text");
  const answer = task.finalAnswer ?? task.latestAssistantText ?? task.assistantText;
  if (answer.trim()) addWrapped(limitText(answer.trim(), DETAILS_TEXT_LIMIT));
  else add(theme.fg("dim", "No assistant text captured yet."));

  addSection("Tool calls/results");
  if (task.toolEvents.length === 0) {
    const assistantToolCalls = [...task.assistantToolCalls.values()].sort(compareBlocks);
    if (assistantToolCalls.length === 0) {
      add(theme.fg("dim", "No child tool calls observed."));
    } else {
      for (const call of assistantToolCalls) {
        add(`${statusIcon("running")} ${call.name ?? "tool call"} ${call.id ?? ""}`.trim());
        if (call.arguments !== undefined) addWrapped(limitText(previewValue(call.arguments), COLLAPSED_TOOL_TEXT_LIMIT), "  args: ");
        else if (call.delta) addWrapped(limitText(call.delta, COLLAPSED_TOOL_TEXT_LIMIT), "  delta: ");
      }
    }
  } else {
    for (const tool of task.toolEvents) {
      const duration = formatElapsed(tool.startedAt, tool.endedAt);
      add(`${statusIcon(tool.status)} ${tool.toolName} · ${tool.status} · ${duration} · ${tool.toolCallId}`);
      addWrapped(limitText(tool.argsPreview, options.showToolDetails ? EXPANDED_TOOL_TEXT_LIMIT : COLLAPSED_TOOL_TEXT_LIMIT), "  args: ");
      const content = tool.resultContentPreview ?? tool.partialContentPreview;
      const details = tool.resultDetailsPreview ?? tool.partialDetailsPreview;
      const limit = options.showToolDetails ? EXPANDED_TOOL_TEXT_LIMIT : COLLAPSED_TOOL_TEXT_LIMIT;
      if (content) addWrapped(limitText(content, limit), "  output: ");
      if (details && options.showToolDetails) addWrapped(limitText(details, limit), "  details: ");
      if (details && !options.showToolDetails) add(theme.fg("dim", "  details hidden (press o)"));
      if (tool.error) addWrapped(limitText(tool.error, limit), "  error: ");
    }
  }

  if (task.error) {
    addSection("Error");
    addWrapped(limitText(task.error, DETAILS_TEXT_LIMIT), "Error: ");
  }

  return lines;
}

function normalizeTuiLine(line: string): string {
  // The TUI width helpers treat tabs as three columns, but terminals and the
  // overlay compositor can expand raw tabs to wider tab stops. Never emit raw
  // tabs from the custom component; expand them before width accounting.
  return line.replace(/\t/g, "   ").replace(/\r/g, "").replace(/\n/g, "↵");
}

function sanitizeUntrustedDisplayText(text: string): string {
  // Tool output can contain terminal escape/control sequences (for example when
  // a sub-agent reads pi-crash.log). Do not render those back into the live TUI:
  // they can affect cursor state, hyperlinks, prompt markers, colors, and width
  // accounting. Preserve real newlines for wrapping, but remove other controls.
  return stripTerminalEscapes(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

function stripTerminalEscapes(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = consumeEscSequence(text, index);
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsiSequence(text, index + 1);
      continue;
    }
    if (code === 0x9d) {
      index = consumeStringControlSequence(text, index + 1);
      continue;
    }
    output += text[index];
    index++;
  }
  return output;
}

function consumeEscSequence(text: string, start: number): number {
  const next = text[start + 1];
  if (!next) return start + 1;
  if (next === "[") return consumeCsiSequence(text, start + 2);
  if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
    return consumeStringControlSequence(text, start + 2);
  }
  // Character-set and simple two-byte escape sequences.
  if (next === "(" || next === ")" || next === "*" || next === "+" || next === "-" || next === "." || next === "/") {
    return Math.min(text.length, start + 3);
  }
  return Math.min(text.length, start + 2);
}

function consumeCsiSequence(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    index++;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function consumeStringControlSequence(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x1b && text[index + 1] === "\\") return index + 2;
    index++;
  }
  return index;
}

function buildPrompt(task: TaskSpec): string {
  return `${task.role ? `Role: ${task.role}\n\n` : ""}${task.systemPrompt ? `Additional instructions:\n${task.systemPrompt}\n\n` : ""}You are a read-only sub-agent. Answer only the assigned task. Do not modify files. Do not attempt edits or shell commands. Use only available read-only tools. Cite relevant file paths and line ranges when possible. Be concise but complete. If uncertain, say what you checked and what remains unknown.\n\nTask:\n${task.task}`;
}

function resolveModel(pattern: string, ctx: ExtensionContext) {
  const slash = pattern.indexOf("/");
  if (slash <= 0)
    throw new Error(`Model must be provider/model, got: ${pattern}`);
  const model = ctx.modelRegistry.find(
    pattern.slice(0, slash),
    pattern.slice(slash + 1),
  );
  if (!model) throw new Error(`Model not found: ${pattern}`);
  return model;
}

async function promisePool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

function formatResults(results: TaskResult[]): string {
  const sections = results.map(
    (r) =>
      `### ${r.id} — ${r.status}\n\n${r.answer ?? `Error: ${r.error ?? "unknown"}`}\n\n_Duration: ${r.durationMs}ms${r.model ? `, model: ${r.model}` : ""}_`,
  );
  const notes = results
    .filter((r) => r.status !== "success")
    .map((r) => `- ${r.id}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
  return `## Sub-agent results\n\n${sections.join("\n\n")}${notes.length ? `\n\n## Notes\n${notes.join("\n")}` : ""}`.trim();
}

function formatRegistrySummary(): string {
  if (subagentRuns.length === 0) return "No delegate_tasks sub-agent runs recorded yet.";
  const activeRuns = subagentRuns.filter((run) => run.status === "running").length;
  const activeTasks = subagentRuns.reduce(
    (count, run) => count + run.tasks.filter((task) => task.status === "running").length,
    0,
  );
  const latest = subagentRuns[subagentRuns.length - 1];
  return `Sub-agents: ${subagentRuns.length} run(s), ${activeRuns} active run(s), ${activeTasks} active task(s). Latest: delegate_tasks #${latest?.ordinal} ${latest?.status}.`;
}

function extractAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantText(messages[i]!);
    if (text.trim()) return text;
  }
  return "";
}

function previewToolContent(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (content === undefined) return undefined;
  return limitText(contentToText(content), PREVIEW_TEXT_LIMIT);
}

function previewToolDetails(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (details === undefined) return undefined;
  return previewValue(details);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return previewValue(content);
  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "image") return `[image ${block.mimeType ?? block.mediaType ?? "unknown"}]`;
      return previewValue(block);
    })
    .join("\n");
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return limitText(value, PREVIEW_TEXT_LIMIT);
  try {
    return limitText(JSON.stringify(value, null, 2), PREVIEW_TEXT_LIMIT);
  } catch {
    return limitText(String(value), PREVIEW_TEXT_LIMIT);
  }
}

function limitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} character(s)]`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function compareBlocks(
  a: { messageSeq: number; contentIndex: number },
  b: { messageSeq: number; contentIndex: number },
): number {
  return a.messageSeq - b.messageSeq || a.contentIndex - b.contentIndex;
}

function countDoneTasks(run: SubagentRunState): number {
  return run.tasks.filter((task) => isFinalTaskStatus(task.status)).length;
}

function isFinalTaskStatus(status: TaskRunStatus): status is TaskStatus {
  return status === "success" || status === "error" || status === "cancelled" || status === "timeout";
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "●";
    case "queued":
      return "○";
    case "success":
      return "✓";
    case "error":
      return "✗";
    case "timeout":
      return "⏱";
    case "cancelled":
      return "◌";
    default:
      return "•";
  }
}

function statusColor(status: string): "success" | "error" | "warning" | "muted" | undefined {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "timeout":
    case "cancelled":
      return "warning";
    case "queued":
      return "muted";
    default:
      return undefined;
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatElapsed(start: number, end?: number): string {
  const elapsed = Math.max(0, (end ?? Date.now()) - start);
  if (elapsed < 1000) return `${elapsed}ms`;
  const seconds = elapsed / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
