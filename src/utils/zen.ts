/**
 * Utility: OpenCode Zen's free tier (gateway/zenfree.go in magpie).
 *
 * Zen's free models (id ends in -free, plus big-pickle and grok-code) are
 * served to OpenCode alone: a request must
 *
 *   - carry OpenCode's headers (service.ts injects those),
 *   - be streamed,
 *   - go to the inference API's URL, not Zen's (/zen/... answers 403
 *     FreeTierError even to OpenCode's own request word for word),
 *   - offer tools named bash and read, each taking a parameter — an
 *     empty-properties schema is refused the same way.
 *
 * This module rewrites a client request so it qualifies, and filters the
 * model's stream back into the client's vocabulary:
 *
 *   - a client tool named bash or read in another case (Claude Code's Bash
 *     and Read) is offered under the lowercase name, and calls come back
 *     under the client's own;
 *   - a missing bash or read is offered as a stub that says never to call
 *     it, with OpenCode's own parameters; a call of a stub is dropped from
 *     the stream, and a turn that called nothing else ends on a stop.
 */

/** Models Zen serves to OpenCode alone, by id. */
const ZEN_FREE_IDS = new Set(["big-pickle", "grok-code"]);

/** The tools Zen's free tier wants offered, by name. */
export const ZEN_TOOLS = ["bash", "read"] as const;

/** The parameters OpenCode itself gives bash and read (1.19.0). */
export const ZEN_TOOL_SCHEMAS: Record<string, unknown> = {
	bash: {
		type: "object",
		properties: {
			command: {
				type: "string",
				description: "The command to execute",
			},
			timeout: {
				type: "integer",
				description: "Optional timeout in milliseconds",
			},
			workdir: {
				type: "string",
				description: "The working directory to run the command in",
			},
		},
		required: ["command"],
	},
	read: {
		type: "object",
		properties: {
			filePath: {
				type: "string",
				description: "The absolute path to the file or directory to read",
			},
			offset: {
				type: "integer",
				description: "The line number to start reading from (1-indexed)",
			},
			limit: {
				type: "integer",
				description: "The maximum number of lines to read",
			},
		},
		required: ["filePath"],
	},
};

/** Description of a tool offered only for the free tier to see. */
export const ZEN_TOOL_STUB_DESCRIPTION =
	"Not available in this session. Never call this tool.";

/** Says whether model is one of Zen's free ones. */
export function isZenFreeModel(model: string): boolean {
	return model.endsWith("-free") || ZEN_FREE_IDS.has(model);
}

/**
 * Rewrites /zen/... onto /inference/... for a free model: since mid-October
 * 2026 Zen answers a free model at /zen/v1 with 403 FreeTierError, and the
 * same request at /inference/v1 with 200. Go's /zen/go keeps its path.
 */
export function zenFreePath(pathname: string): { path: string; rewrittenFrom?: string } {
	const rest = pathname.match(/^\/zen(\/.*)?$/);
	if (!rest || rest[1] === "/go" || rest[1]?.startsWith("/go/")) {
		return { path: pathname };
	}
	return { path: "/inference" + (rest[1] ?? ""), rewrittenFrom: pathname };
}

/**
 * Offers a request body's tools the way the free tier wants them and forces
 * stream:true. body must be JSON of a chat completions request; it is
 * returned as a new JSON string, or unchanged when it does not parse.
 */
export function zenFreeRequestBody(raw: string): string {
	let m: {
		stream?: unknown;
		tools?: unknown[];
		tool_choice?: unknown;
		messages?: Array<Record<string, unknown>>;
		[key: string]: unknown;
	};
	try {
		m = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (!m || typeof m !== "object" || Array.isArray(m)) return raw;

	m.stream = true;
	const tools = Array.isArray(m.tools) ? [...m.tools] : [];
	// tool name under which it was offered -> the client's own name
	const back = new Map<string, string>();
	for (const need of ZEN_TOOLS) {
		const i = tools.findIndex(
			(t) =>
				t &&
				typeof t === "object" &&
				toolName(t as Record<string, unknown>) === need,
		);
		if (i >= 0) continue;
		const j = tools.findIndex(
			(t) =>
				t &&
				typeof t === "object" &&
				typeof toolName(t as Record<string, unknown>) === "string" &&
				(toolName(t as Record<string, unknown>) as string).toLowerCase() ===
					need,
		);
		if (j >= 0) {
			const own = toolName(tools[j] as Record<string, unknown>) as string;
			back.set(need, own);
			tools[j] = renameTool(tools[j] as Record<string, unknown>, need);
			continue;
		}
		tools.push({
			type: "function",
			function: {
				name: need,
				description: ZEN_TOOL_STUB_DESCRIPTION,
				parameters: ZEN_TOOL_SCHEMAS[need],
			},
		});
	}
	m.tools = tools;

	// Rename the client's tool calls in the conversation so far, so the
	// model sees one spelling of its tools throughout.
	if (back.size > 0 && Array.isArray(m.messages)) {
		const to = new Map([...back].map(([up, own]) => [own, up]));
		m.messages = m.messages.map((msg) => {
			const calls = msg?.tool_calls;
			if (!Array.isArray(calls)) return msg;
			const renamed = calls.map((c) => {
				const fn = (c as Record<string, unknown>)?.function as
					| Record<string, unknown>
					| undefined;
				const name = fn?.name;
				if (typeof name === "string" && to.has(name)) {
					return {
						...(c as Record<string, unknown>),
						function: { ...fn, name: to.get(name) },
					};
				}
				return c;
			});
			return { ...msg, tool_calls: renamed };
		});
		if (typeof m.tool_choice === "object" && m.tool_choice !== null) {
			const tc = m.tool_choice as Record<string, unknown>;
			const fn = tc.function as Record<string, unknown> | undefined;
			if (fn && typeof fn.name === "string" && to.has(fn.name)) {
				m.tool_choice = {
					...tc,
					function: { ...fn, name: to.get(fn.name) },
				};
			}
		}
	}

	return JSON.stringify(m);
}

/** Reads a chat completions tool's function name out of either shape. */
function toolName(t: Record<string, unknown>): unknown {
	if (typeof t.name === "string") return t.name;
	const fn = t.function as Record<string, unknown> | undefined;
	return fn?.name;
}

/** Returns the tool offered under the new name. */
function renameTool(t: Record<string, unknown>, name: string): unknown {
	if (typeof t.name === "string") return { ...t, name };
	const fn = t.function as Record<string, unknown> | undefined;
	if (fn) return { ...t, function: { ...fn, name } };
	return t;
}

/**
 * Filters a chat completions SSE stream back into the client's vocabulary:
 * tool-call names renamed back, calls of a stub dropped, and a turn that
 * called nothing but a stub turned into a plain stop.
 */
export function zenFreeStreamFilter(back: Map<string, string>, stubs: Set<string>) {
	// [OpenAI tool-call index on the wire] -> dropping?
	const dropping = new Map<number, boolean>();
	return (chunk: Record<string, unknown>): Record<string, unknown> | null => {
		const choices = chunk?.choices;
		if (!Array.isArray(choices)) return chunk;
		const out = choices.map((c) => {
			const ch = c as Record<string, unknown>;
			const delta = ch.delta as Record<string, unknown> | undefined;
			const calls = delta?.tool_calls;
			if (!Array.isArray(calls)) return ch;
			const toolCalls = calls.map((raw) => {
				const call = raw as Record<string, unknown>;
				const idx = typeof call.index === "number" ? call.index : 0;
				const fn = call.function as Record<string, unknown> | undefined;
				// First sight of this call: is it a stub's?
				if (fn && typeof fn.name === "string" && fn.name !== "") {
					dropping.set(idx, stubs.has(fn.name));
					const own = back.get(fn.name);
					if (own) {
						return {
							...call,
							function: { ...fn, name: own },
						};
					}
					return call;
				}
				return call;
			});
			const kept = toolCalls.filter(
				(raw, i) => !dropping.get(typeof (raw as Record<string, unknown>).index === "number" ? (raw as Record<string, unknown>).index as number : i),
			);
			return {
				...ch,
				delta: { ...delta, tool_calls: kept },
			};
		});
		return { ...chunk, choices: out };
	};
}
