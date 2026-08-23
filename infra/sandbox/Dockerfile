FROM oven/bun:1.3.14-debian

LABEL org.opencontainers.image.title="OpenCode tool sandbox" \
  org.opencontainers.image.description="Minimal offline runtime for model-initiated Shell, Python, and TypeScript" \
  ai.opencode.sandbox.image="true"

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    jq \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN git config --system --add safe.directory /workspace \
  && install -d -o root -g root -m 0755 /opt/opencode/bin \
  && command -v bun \
  && command -v git \
  && command -v jq \
  && command -v python3 \
  && command -v rg \
  && test -x /bin/sh \
  && test -x /usr/bin/timeout \
  && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

ENV HOME=/tmp
ENV TMPDIR=/tmp
ENV PATH=/usr/local/bin:/usr/bin:/bin
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /workspace
USER 65532:65532

ENTRYPOINT []
