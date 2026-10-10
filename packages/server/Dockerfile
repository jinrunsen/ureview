# 构建阶段包含 dsh 原生依赖所需的工具。
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/session-viewer/package.json ./packages/session-viewer/
RUN npm pkg delete scripts.prepare && npm ci

COPY packages/server ./packages/server
COPY packages/web ./packages/web
COPY packages/session-viewer ./packages/session-viewer
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY packages/server/package.json ./packages/server/
# dist 包含构建时复制的 rule-library 数据，运行时可离线读取。
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/session-viewer/dist ./packages/session-viewer/dist
COPY packages/server/migrations ./packages/server/migrations

# compose 为代码工作副本和凭据挂载具名卷。
RUN mkdir -p /srv/worktrees /srv/blobs
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
