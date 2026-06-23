FROM node:22-alpine AS base
RUN npm install -g pnpm

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile

# Build both client (vite) and server (esbuild)
# vite builds React into dist/public, esbuild compiles Express into dist/index.js
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN NODE_ENV=production pnpm build

# Production runtime
FROM node:22-alpine AS runner
RUN apk add --no-cache python3 py3-pip ffmpeg && pip3 install --break-system-packages yt-dlp
RUN npm install -g pnpm
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
