# syntax=docker/dockerfile:1

# Build: every dependency, then the bundle, then the production ones alone.
FROM node:24-alpine AS build
WORKDIR /app
# The pnpm that package.json names in packageManager.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build && CI=true pnpm prune --prod --ignore-scripts

# Run: Node, the bundle and its dependencies. No package manager, no sources.
FROM node:24-alpine
ENV NODE_ENV=production
# All interfaces: in a container, loopback is the container's own.
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The image's unprivileged user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Node itself as PID 1 would ignore SIGTERM without the handlers in main.ts.
CMD ["node", "dist/main.js"]
