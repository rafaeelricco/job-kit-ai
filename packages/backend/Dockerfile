FROM node:22-alpine
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/frontend/package.json packages/frontend/
COPY packages/lib/package.json packages/lib/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,id=job-kit-server-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @job-kit/backend...
COPY packages/lib packages/lib
COPY packages/backend packages/backend
WORKDIR /app/packages/backend
RUN pnpm build
EXPOSE 8080
CMD ["pnpm", "start"]
