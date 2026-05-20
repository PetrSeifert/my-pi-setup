import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev";
const MAX_MARKDOWN_CHARS = 12000;

const SearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default 5, max 10)" })),
	scrape: Type.Optional(Type.Boolean({ description: "Include page markdown for search results when Firecrawl supports it" })),
});

const ScrapeParams = Type.Object({
	url: Type.String({ description: "URL to scrape" }),
	maxChars: Type.Optional(Type.Number({ description: "Maximum markdown characters to return (default 12000)" })),
});

type FirecrawlResponse = {
	success?: boolean;
	data?: unknown;
	error?: string;
	message?: string;
};

function apiKey(): string {
	const key = process.env.FIRECRAWL_API_KEY ?? readCliApiKey();
	if (!key) {
		throw new Error("FIRECRAWL_API_KEY is not set and Firecrawl CLI credentials were not found. Run `npx -y firecrawl-cli@latest init --all -k <key>` or export FIRECRAWL_API_KEY before starting pi.");
	}
	return key;
}

function readCliApiKey(): string | undefined {
	const credentialsPath = join(homedir(), ".config", "firecrawl-cli", "credentials.json");
	if (!existsSync(credentialsPath)) return undefined;
	try {
		const credentials = JSON.parse(readFileSync(credentialsPath, "utf8")) as { apiKey?: string };
		return credentials.apiKey;
	} catch {
		return undefined;
	}
}

async function firecrawl(path: string, body: unknown, signal?: AbortSignal): Promise<FirecrawlResponse> {
	const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	let json: FirecrawlResponse;
	try {
		json = text ? (JSON.parse(text) as FirecrawlResponse) : {};
	} catch {
		json = { error: text };
	}

	if (!response.ok || json.success === false) {
		throw new Error(json.error ?? json.message ?? `Firecrawl request failed (${response.status})`);
	}
	return json;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]` : value;
}

export default function firecrawlSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the internet using Firecrawl and return relevant results.",
		promptSnippet: "Search the internet using Firecrawl",
		promptGuidelines: [
			"Use web_search when current or external information from the internet is needed.",
			"Use web_scrape when the user provides a URL or when a search result needs more page detail.",
		],
		parameters: SearchParams,
		async execute(_toolCallId, params, signal) {
			const limit = Math.max(1, Math.min(params.limit ?? 5, 10));
			const result = await firecrawl(
				"/v1/search",
				{
					query: params.query,
					limit,
					...(params.scrape ? { scrapeOptions: { formats: ["markdown"] } } : {}),
				},
				signal,
			);

			return {
				content: [{ type: "text", text: JSON.stringify(result.data ?? result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "web_scrape",
		label: "Web Scrape",
		description: "Scrape a webpage using Firecrawl and return markdown content.",
		promptSnippet: "Scrape a webpage using Firecrawl",
		parameters: ScrapeParams,
		async execute(_toolCallId, params, signal) {
			const result = await firecrawl(
				"/v1/scrape",
				{ url: params.url, formats: ["markdown"] },
				signal,
			);
			const data = result.data as { markdown?: string; content?: string } | undefined;
			const markdown = data?.markdown ?? data?.content ?? JSON.stringify(result.data ?? result, null, 2);
			const maxChars = Math.max(1000, Math.min(params.maxChars ?? MAX_MARKDOWN_CHARS, 50000));

			return {
				content: [{ type: "text", text: truncate(markdown, maxChars) }],
				details: result,
			};
		},
	});

	pi.registerCommand("firecrawl", {
		description: "Show Firecrawl extension status",
		handler: async (_args, ctx) => {
			const configured = Boolean(process.env.FIRECRAWL_API_KEY ?? readCliApiKey());
			ctx.ui.notify(
				configured
					? "Firecrawl tools are available: web_search, web_scrape"
					: "Set FIRECRAWL_API_KEY or run Firecrawl CLI init, then /reload",
				configured ? "info" : "warning",
			);
		},
	});
}
