# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# --- Build: compile TypeScript ---
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime: production deps + compiled JS + migrations ---
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

USER node
CMD ["node", "dist/index.js"]
