# Cross-build readsb for the Orange Pi i96 ADS-B receiver.
# Target: armv7l/armhf, Debian 11 bullseye (glibc 2.31). Built on bullseye
# specifically so the binary links glibc 2.31 and runs on the board unchanged.
# Platform is supplied by `docker buildx build --platform linux/arm/v7 ...`.
FROM debian:bullseye AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential make gcc git ca-certificates pkg-config \
      libusb-1.0-0-dev librtlsdr-dev zlib1g-dev libzstd-dev libncurses-dev \
 && rm -rf /var/lib/apt/lists/*

# Empty ref => clone the repo's default branch (wiedehopf/readsb defaults to dev).
ARG READSB_REF=
RUN if [ -n "$READSB_REF" ]; then \
      git clone --depth 1 --branch "$READSB_REF" https://github.com/wiedehopf/readsb.git /src; \
    else \
      git clone --depth 1 https://github.com/wiedehopf/readsb.git /src; \
    fi
WORKDIR /src
RUN make RTLSDR=yes -j"$(nproc)"

# Report what we built (informational; never fails the build).
RUN ls -la readsb || true; \
    echo '--- NEEDED libs ---'; objdump -p readsb | grep NEEDED || true; \
    echo '--- max GLIBC symbol version ---'; \
    objdump -T readsb | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -3 || true

# Export stage: only the binary lands in the buildx local output dir.
FROM scratch AS export
COPY --from=build /src/readsb /readsb
