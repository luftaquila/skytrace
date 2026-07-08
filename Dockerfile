FROM node:22-alpine AS web
WORKDIR /build
COPY web/package*.json web/
RUN npm --prefix web ci
COPY web/ web/
RUN npm --prefix web run build

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV SKYTRACE_DB_PATH=/data/skytrace.db
COPY --from=deps /app/node_modules node_modules/
COPY package.json ./
COPY src/ src/
COPY bin/ bin/
COPY --from=web /build/web/dist web/dist/
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "src/index.mjs"]
