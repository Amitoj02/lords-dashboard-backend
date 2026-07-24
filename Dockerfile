# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build for the Lords Dashboard API.
#   deps  → all dependencies (dev + prod), used by dev + build
#   dev   → hot-reloading dev server (source is bind-mounted by the compose dev
#           override; node_modules stay in an anonymous volume)
#   build → compiles TypeScript to dist/
#   prod-deps → production-only node_modules (slim)
#   prod  → slim runtime: dist/ + prod node_modules, runs compiled JS (no ts-node)
# The `prod` image is reused by the one-shot migrate/seed init service, which
# runs the compiled TypeORM CLI + seed against the db before the api starts.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app
# Disable @scarf/scarf install-time telemetry (LDA-L2): a prod dependency whose
# postinstall otherwise phones home on every image build.
ENV SCARF_ANALYTICS=false
COPY package.json package-lock.json ./
RUN npm ci

# ── Development image: nest watch, source bind-mounted at runtime ────────────
FROM node:26-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ── Build: compile to dist/ ──────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# ── Production dependencies only ─────────────────────────────────────────────
FROM node:26-alpine AS prod-deps
WORKDIR /app
ENV SCARF_ANALYTICS=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Production runtime: slim, compiled JS only ───────────────────────────────
FROM node:26-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
# wget (for the healthcheck) ships with alpine's busybox.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
# Run as the built-in non-root node user.
USER node
CMD ["node", "dist/main.js"]
