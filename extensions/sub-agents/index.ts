import { StringEnum } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

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

interface TaskResult {
  id: string;
  task: string;
  status: TaskStatus;
  answer?: string;
  error?: string;
  durationMs: number;
  model?: string;
}

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
      _toolCallId,
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

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Starting ${tasks.length} sub-agent task(s), concurrency ${concurrency}...`,
          },
        ],
      });

      const results = await promisePool(
        tasks,
        concurrency,
        async (task, index) => {
          const id = task.id ?? `task-${index + 1}`;
          onUpdate?.({
            content: [{ type: "text", text: `Sub-agent ${id} running...` }],
          });
          const result = await runSubAgentTask(
            task,
            id,
            ctx,
            {
              model: params.model,
              thinkingLevel: params.thinkingLevel,
              timeoutMs,
            },
            signal,
          );
          onUpdate?.({
            content: [
              { type: "text", text: `Sub-agent ${id} ${result.status}.` },
            ],
          });
          return result;
        },
      );

      const markdownSummary = formatResults(results);
      return {
        content: [{ type: "text", text: markdownSummary }],
        details: { results },
      };
    },
  });

  pi.registerCommand("subagent-test", {
    description: "Smoke test the delegate_tasks extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Ask the agent to call delegate_tasks with: summarize the top-level files in this repo.",
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
  parentSignal?: AbortSignal,
): Promise<TaskResult> {
  const started = Date.now();
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
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
    });
    await loader.reload();
    const model = options.model ? resolveModel(options.model, ctx) : ctx.model;
    ({ session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model,
      thinkingLevel: options.thinkingLevel,
      modelRegistry: ctx.modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager,
      tools: READ_ONLY_TOOLS,
    }));

    let answer = "";
    session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        answer += event.assistantMessageEvent.delta;
      }
    });
    await session.prompt(buildPrompt(task), { source: "extension" });
    return {
      id,
      task: task.task,
      status: "success",
      answer: answer.trim() || "(no assistant text captured)",
      durationMs: Date.now() - started,
      model: model ? `${model.provider}/${model.id}` : undefined,
    };
  } catch (error) {
    const status: TaskStatus = parentSignal?.aborted
      ? "cancelled"
      : timedOut
        ? "timeout"
        : "error";
    return {
      id,
      task: task.task,
      status,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
    timeoutController.signal.removeEventListener("abort", onTimeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
    session?.dispose();
  }
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
  return `## Sub-agent results\n\n${sections.join("\n\n")} ${notes.length ? `\n\n## Notes\n${notes.join("\n")}` : ""}`.trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
