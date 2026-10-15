/**
 * Utility: upstream path canonicalisation.
 *
 * OpenCode moved Console inference to family-scoped endpoints
 * (anomalyco/opencode#54777, 2026-10-12) and made the new inference service
 * own authentication, model availability, free-tier access and billing
 * (anomalyco/opencode#55103 / #55120, 2026-10-13). The gateway maps its own
 * routes onto those paths:
 *
 *     POST /zen/v1/chat/completions -> /openai/v1/chat/completions
 *     POST /zen/go/v1/messages      -> /go/anthropic/v1/messages
 *
 * A channel pointed straight at the inference base still asks for the
 * family-less form (`/inference/v1/chat/completions`). That alias is routed
 * today, but it is neither documented nor in the gateway table, so it is
 * rewritten onto the canonical path here instead of being depended on.
 *
 * `/inference/v1/models` is deliberately absent: the docs publish that
 * family-less path as the live model list, so only the request endpoints move.
 */

/** Exact routes that moved behind an API-family segment. */
export const CANONICAL_PATHS: ReadonlyArray<{ from: string; to: string }> = [
	{
		from: "/inference/v1/chat/completions",
		to: "/inference/openai/v1/chat/completions",
	},
	{ from: "/inference/v1/responses", to: "/inference/openai/v1/responses" },
	{ from: "/inference/v1/messages", to: "/inference/anthropic/v1/messages" },
	{
		from: "/inference/go/v1/chat/completions",
		to: "/inference/go/openai/v1/chat/completions",
	},
	{
		from: "/inference/go/v1/responses",
		to: "/inference/go/openai/v1/responses",
	},
	{
		from: "/inference/go/v1/messages",
		to: "/inference/go/anthropic/v1/messages",
	},
];

/** Gemini keeps the model and method in the path, so it moves by prefix. */
const CANONICAL_PREFIXES: ReadonlyArray<{ from: string; to: string }> = [
	{
		from: "/inference/v1beta/models/",
		to: "/inference/google/v1beta/models/",
	},
	{
		from: "/inference/go/v1beta/models/",
		to: "/inference/go/google/v1beta/models/",
	},
];

export interface UpstreamPath {
	/** Path to send upstream. */
	path: string;
	/** The path the caller asked for, when it was rewritten. */
	rewrittenFrom?: string;
}

/**
 * Maps a caller path onto the canonical upstream path. Already-canonical
 * paths, unknown paths and every other route pass through untouched.
 */
export function canonicalPath(pathname: string, enabled: boolean): UpstreamPath {
	if (!enabled) return { path: pathname };

	for (const { from, to } of CANONICAL_PATHS)
		if (pathname === from) return { path: to, rewrittenFrom: from };

	for (const { from, to } of CANONICAL_PREFIXES)
		if (pathname.startsWith(from))
			return { path: to + pathname.slice(from.length), rewrittenFrom: from };

	return { path: pathname };
}
