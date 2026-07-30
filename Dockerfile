ARG NODE_IMAGE=node:24.18.0-alpine3.24
FROM ${NODE_IMAGE} AS web
WORKDIR /build
COPY web/package*.json web/
RUN npm --prefix web ci
# The notices generator runs in BOTH stages: the two dependency trees it has to cover never coexist
# in one stage, so each contributes its own half to the same output file.
COPY scripts/notices.mjs scripts/
COPY web/ web/
RUN npm --prefix web run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE}
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses=GPL-3.0-only
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV SKYTRACE_DB_PATH=/data/skytrace.db
COPY --from=deps /app/node_modules node_modules/
COPY package.json ./
COPY LICENSE ./
COPY server/ server/
COPY --from=web /build/web/dist web/dist/
# The web half already sits in dist; this merges the server's prod tree into the same file. It has to
# run after the dist copy, because it reads that file back.
COPY scripts/notices.mjs scripts/
RUN node scripts/notices.mjs --packages . --scope server --out web/dist/third-party-notices.json
# Runtime data is the only writable tree. Application code and dependencies remain root-owned and
# read-only, so a compromised node process cannot persist by rewriting what the next restart runs.
RUN install -d -o node -g node -m 0700 /data && chmod -R a-w /app
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]
