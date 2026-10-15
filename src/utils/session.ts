/**
 * Utility: mints structurally valid `x-opencode-session` values.
 *
 * OpenCode's gateway expects requests that look like an OpenCode client,
 * and the session header must match
 *     ses_ + 12 hex + exactly 14 base62          (30 chars)
 * where the 12 hex encode a timestamp and a `counter` that must be 1..63
 * (a larger counter is rejected, and the timestamp bits are not checked).
 * new-api cannot compose such a value from configuration, so the value is
 * minted here. The 14 base62 chars identify the conversation, giving a
 * stable, distinct session per user/conversation.
 *
 * The prefix used by default is minted once per conversation, so the
 * timestamp inside it is the moment the conversation started rather than a
 * moment frozen into a constant months ago.
 */

import { sessionPrefixFor } from "./fingerprint";

// The constant prefix this proxy used to send for everyone. It is no longer
// the default (prefixes are minted per conversation), but pinning it with
// SESSION_PREFIX=ses_ecbe61115ffe restores the old behaviour.
export const DEFAULT_SESSION_PREFIX = "ses_ecbe61115ffe";

// Kept for reference; the per-conversation fingerprint supplies the default
// UA and client tag. USER_AGENT/CLIENT env vars override it.
export const FALLBACK_USER_AGENT = "opencode/latest/2.0.29/cli";
export const FALLBACK_CLIENT = "cli";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Headers that name a conversation, tried in order. Whatever the client sends
 * here keeps one conversation on one session across turns.
 */
export const SEED_HEADERS = [
	"x-oc-session",
	"x-opencode-session-id",
	"x-opencode-session",
	"session_id",
	"session-id",
	"x-session-id",
	"x-conversation-id",
	"thread_id",
	"thread-id",
	"x-client-request-id",
	"x-request-id",
] as const;

/**
 * 14 base62 chars derived from a hash: 62^14 > 2^83, so 10 hash bytes are
 * plenty.
 */
export function suffixFor(seed: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(seed).digest();
	let n = 0n;
	for (const byte of digest.subarray(0, 10)) n = (n << 8n) | BigInt(byte);
	let out = "";
	for (let i = 0; i < 14; i++) {
		out = B62[Number(n % 62n)] + out;
		n /= 62n;
	}
	return out;
}

/**
 * Derives a stable seed for a conversation from the incoming request.
 * Prefers an explicit conversation header, then the first user message,
 * and finally falls back to hashing the whole body.
 */
export function conversationSeed(
	headers: Record<string, string | undefined>,
	rawBody: string,
): string {
	for (const name of SEED_HEADERS) {
		const value = headers[name];
		if (value && String(value).trim())
			return `${name}:${String(value).trim()}`;
	}

	try {
		const parsed = JSON.parse(rawBody || "{}") as {
			messages?: unknown[];
			input?: unknown;
		};
		const items = Array.isArray(parsed.messages)
			? parsed.messages
			: Array.isArray(parsed.input)
				? parsed.input
				: null;
		const first = items?.find(
			(item: unknown) =>
				item != null &&
				(typeof item === "string" ||
					(typeof item === "object" &&
						(item as { role?: unknown }).role === "user")),
		);
		if (first) return `first:${JSON.stringify(first)}`;
		if (typeof parsed.input === "string") return `input:${parsed.input}`;
	} catch {
		// Not JSON: fall through to hashing the whole body.
	}

	return `body:${rawBody}`;
}

/** Builds the full `ses_...` session id for a conversation suffix. */
export function sessionFor(prefix: string, suffix: string): string {
	return prefix + suffix;
}

/** How the 12-hex session prefix is chosen. */
export type SessionMode = "fixed" | "per-request" | "per-conversation";

/**
 * Resolves the configured prefix mode. SESSION_PREFIX pins one value,
 * ROTATE_SESSION_PREFIX mints one per request, and the default mints one per
 * conversation.
 */
export function sessionModeOf(config: {
	rotateSessionPrefix: boolean;
	sessionPrefix: string | null;
}): SessionMode {
	if (config.rotateSessionPrefix) return "per-request";
	return config.sessionPrefix ? "fixed" : "per-conversation";
}

/**
 * Session prefixes already minted, keyed by conversation suffix.
 *
 * The prefix carries the start time of the session, and the gateway uses the
 * session for routing and prompt-cache affinity, so a conversation must keep
 * one session for its whole life while a new conversation must not reuse an
 * old timestamp. Entries expire so a long-lived process does not accumulate
 * one per conversation forever.
 */
const PREFIX_TTL_MS = 12 * 60 * 60 * 1000;
const PREFIX_CACHE_LIMIT = 4096;
const prefixes = new Map<string, { prefix: string; mintedAt: number }>();

/** Returns the conversation's session prefix, minting one on first sight. */
export function conversationPrefixFor(
	conversation: string,
	counter: number,
	now = Date.now(),
): string {
	const cached = prefixes.get(conversation);
	if (cached && now - cached.mintedAt < PREFIX_TTL_MS) return cached.prefix;

	const prefix = sessionPrefixFor(counter, now);
	if (prefixes.size >= PREFIX_CACHE_LIMIT) {
		const oldest = prefixes.keys().next();
		if (!oldest.done) prefixes.delete(oldest.value);
	}
	prefixes.set(conversation, { prefix, mintedAt: now });
	return prefix;
}

/** Re-exported so the service layer can seed identities from one place. */
export { conversationSeed as conversationSeedOf };

