FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8080 DB_PATH=/data/standup.db
EXPOSE 8080
CMD ["bun", "src/index.ts"]
