# Stage 1: build the web app (dev dependencies stay here).
FROM oven/bun:1-alpine AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile
COPY web ./web
RUN bun run web:build

# Stage 2: the runtime image — server source plus the built web bundle.
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8080 DB_PATH=/data/standup.db
EXPOSE 8080
CMD ["bun", "src/index.ts"]
