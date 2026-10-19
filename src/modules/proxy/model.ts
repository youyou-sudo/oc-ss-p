import { t, type UnwrapSchema } from "elysia";

/**
 * Model: the single source of truth for proxy config shapes.
 *
 * `RawEnv` models process.env, where every value is a string.
 * Parsed shapes are validated at runtime by the service layer.
 */
export const ProxyModel = {
	/** Raw environment variables, everything arrives as a string. */
	rawEnv: t.Object({
		PORT: t.Optional(t.String({ pattern: "^[0-9]+$" })),
		HOST: t.Optional(t.String()),
		UPSTREAM: t.Optional(t.String({ format: "uri" })),
		PROXIES: t.Optional(t.String()),
		EGRESS_STRATEGY: t.Optional(
			t.String({ pattern: "^(stable|round-robin|random)$" }),
		),
		SESSION_COUNTER: t.Optional(t.String({ pattern: "^[0-9]+$" })),
		SESSION_PREFIX: t.Optional(
			t.String({
				pattern: "^ses_[0-9a-f]{12}$",
				description: "12 hex chars of a valid OpenCode session id",
			}),
		),
		ROTATE_SESSION_PREFIX: t.Optional(
			t.String({ pattern: "^(1|0|true|false)$" }),
		),
		USER_AGENT: t.Optional(t.String()),
		CLIENT: t.Optional(t.String()),
		CANONICALIZE_PATHS: t.Optional(
			t.String({ pattern: "^(1|0|true|false)$" }),
		),
		VERBOSE: t.Optional(t.String({ pattern: "^(1|0|true|false)$" })),
		/** xc-p panel / service API base, e.g. http://127.0.0.1:8080. */
		XCP_HOST: t.Optional(t.String({ format: "uri" })),
		/** Service API key (`read` + `credentials` scopes). */
		XCP_API_KEY: t.Optional(t.String()),
		XCP_REFRESH_MS: t.Optional(t.String({ pattern: "^[0-9]+$" })),
		XCP_RETRIES: t.Optional(t.String({ pattern: "^[0-9]+$" })),
		XCP_STATE: t.Optional(t.String()),
		XCP_RESET_HOUR: t.Optional(t.String({ pattern: "^[0-9]+$" })),
	}),

	/** Parsed, typed configuration used by the service. */
	config: t.Object({
		upstream: t.String({ format: "uri" }),
		port: t.Integer({ minimum: 1, maximum: 65535 }),
		host: t.String(),
		/**
		 * Fixed prefix, or null when prefixes are minted per conversation.
		 */
		sessionPrefix: t.Union([
			t.String({ pattern: "^ses_[0-9a-f]{12}$" }),
			t.Null(),
		]),
		/** Per-millisecond id increment OpenCode embeds in the 12 hex chars. */
		sessionCounter: t.Integer({ minimum: 1, maximum: 4095 }),
		rotateSessionPrefix: t.Boolean(),
		/** Fixed UA override, or null to use the per-conversation fingerprint. */
		userAgent: t.Union([t.String(), t.Null()]),
		/** Fixed client tag, or null to use the fingerprint. */
		client: t.Union([t.String(), t.Null()]),
		proxies: t.Array(
			t.Object({
				url: t.String({ pattern: "^https?://" }),
				label: t.Optional(t.String()),
			}),
		),
		egressStrategy: t.String({ pattern: "^(stable|round-robin|random)$" }),
		/**
		 * xc-p node pool, or null when XCP_HOST is unset. When set it
		 * replaces the static pool as the source of egress hops.
		 */
		xcp: t.Union([
			t.Object({
				host: t.String({ format: "uri" }),
				/** Service API key; empty only for a control plane without auth. */
				apiKey: t.String(),
				/** How often the node list is re-read. */
				refreshMs: t.Integer({ minimum: 10_000 }),
				/** File holding the daily rate-limit record. */
				statePath: t.String(),
				/** Hour the record rolls over. */
				resetHour: t.Integer({ minimum: 0, maximum: 23 }),
			}),
			t.Null(),
		]),
		/** Extra attempts after a 429 or an unreachable hop (0 disables). */
		egressRetries: t.Integer({ minimum: 0, maximum: 5 }),
		/** Rewrite legacy family-less inference paths onto their family. */
		canonicalizePaths: t.Boolean(),
		verbose: t.Boolean(),
	}),

	/** Response body when the upstream cannot be reached. */
	upstreamUnreachable: t.String(),
} as const;

export type ProxyModel = {
	[k in keyof typeof ProxyModel]: UnwrapSchema<typeof ProxyModel[k]>;
};

