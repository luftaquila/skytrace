ARG NODE_IMAGE=node:24.18.0-alpine3.24
ARG GO_IMAGE=golang:1.26.5-alpine3.24
FROM ${NODE_IMAGE} AS web
WORKDIR /build
COPY web/package*.json web/
RUN npm --prefix web ci
# Browser dependency notices are generated here; linked Go module notices are merged below.
COPY scripts/notices.mjs scripts/
COPY web/ web/
RUN npm --prefix web run build

FROM ${GO_IMAGE} AS server
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=web /build/web/dist web/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/skytrace ./cmd/skytrace
# Merge notices for the modules that are actually linked into the static server binary.
RUN go list -m -json all \
      | go run ./cmd/notices \
          --binary /out/skytrace \
          --scope server \
          --out web/dist/third-party-notices.json

FROM alpine:3.24
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses=GPL-3.0-only
WORKDIR /app
ENV PORT=3000
ENV SKYTRACE_DB_PATH=/data/skytrace.db
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -g 1000 skytrace \
    && adduser -D -H -u 1000 -G skytrace skytrace
COPY LICENSE ./
COPY --from=server /out/skytrace /app/skytrace
COPY --from=server /build/web/dist web/dist/
# Runtime data is the only writable tree. Application code and dependencies remain root-owned and
# read-only, so a compromised server process cannot persist by rewriting what the next restart runs.
RUN install -d -o skytrace -g skytrace -m 0700 /data && chmod -R a-w /app
USER skytrace
EXPOSE 3000
CMD ["/app/skytrace"]
