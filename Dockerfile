# Build stage: compile single-file server binary with Bun
FROM oven/bun:1.4.3-slim AS build

WORKDIR /app

# Cache packages
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY src ./src

ENV NODE_ENV=production

# Compile the Elysia app into a single executable. Flags mirror the Release
# workflow build (release.yml) — production + minify. Runtime configuration is
# read from the process environment; there is no config.json in this project,
# so nothing but the binary needs to be copied next to it.
RUN bun build ./src/index.ts --compile --production --minify --outfile server

# Production stage: distroless runtime (no shell / no package manager)
FROM gcr.io/distroless/base

WORKDIR /app

# Single binary
COPY --from=build /app/server /app/server

# Environment variables
ENV NODE_ENV=production

# Healthcheck: runs the bundled healthcheck CLI (GET /health, expects {ok:true}).
# The binary carries the probe because the distroless base image has no
# curl/wget/shell to run one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/app/server", "healthcheck"]

# Default command
CMD ["/app/server"]

EXPOSE 8787
