# CHAMELEON reasoning server - production image.
#
# This directory (apps/server/) is a genuinely standalone deployable - it
# has no workspace/monorepo dependency (see ../../docs/DEPLOYMENT.md,
# verified during development by copying this folder alone into an
# isolated directory and running it with zero TypeScript support). This
# Dockerfile has NOT been build-tested in the sandbox that produced this
# repository (no Docker daemon was available there) - the plain
# `npm install && npm run build && npm start` path in DEPLOYMENT.md is the
# one that was actually run and verified end-to-end. This Dockerfile
# follows the same steps inside a standard two-stage Node build, so it
# should work, but treat "docker build" as your first real test of it.

# ---- deps + build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies (typescript, tsx, @types/*) out of node_modules
# now that the build step that needed them is done.
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user - this image never needs root.
RUN addgroup -S chameleon && adduser -S chameleon -G chameleon

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER chameleon

# Overridden by the platform's own $PORT env var on most PaaS targets
# (Render, Railway, Fly, Heroku all inject PORT) - config.ts reads
# process.env.PORT with 8787 as the local-dev default.
ENV PORT=8787
EXPOSE 8787

# No external AI provider is required to boot - AI_PROVIDER defaults to
# "mock" (see .env.example) so this image is runnable out of the box.
# Set AI_PROVIDER=openai-compatible + AI_BASE_URL/AI_MODEL/AI_API_KEY at
# deploy time to use a real model.
CMD ["node", "dist/index.js"]
