/**
 * Utility: mints structurally valid `x-opencode-session` values.
 *
 * OpenCode's free tier only accepts requests that look like an OpenCode
 * client, and the session header must match
 *     ses_ + 12 hex + exactly 14 base62          (30 chars)
 * where the 12 hex encode a timestamp and a `counter` that must be 1..63
 * (a larger counter is rejected, and the timestamp bits are not checked).
 * new-api cannot compose such a value from configuration, so the value is
 * minted here. The 14 base62 chars identify the conversation, giving a
 * stable, distinct session per user/conversation.
 */

// A fixed 12-hex session prefix (counter = 1 encodes as 0xffe), used when
// ROTATE_SESSION_PREFIX is off.
export const DEFAULT_SESSION_PREFIX = "ses_ecbe61115ffe";

// Kept for reference; the per-conversation fingerprint now supplies the
// default UA and client tag. USER_AGENT/CLIENT env vars override it.
export const FALLBACK_USER_AGENT = "opencode/latest/2.0.23/cli";
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

/** Re-exported so the service layer can seed identities from one place. */
export { conversationSeed as conversationSeedOf };

