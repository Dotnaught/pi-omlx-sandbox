# The plain shell template, not the -docker variant sbx/pi-image builds on: that
# one starts a Docker engine that runs for the sandbox's lifetime, and setting
# com.docker.sandboxes.start-docker=false on top of it breaks sandbox startup.
# Pinned by digest; bump it deliberately to take template updates.
ARG BASE_DIGEST=sha256:c66aa9c0212bb710089cc356501f8bde8989e02a7071bf1c6be0893be1c30adf
FROM docker/sandbox-templates:shell@${BASE_DIGEST}

USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends fd-find && \
    ln -s /usr/bin/fdfind /usr/local/bin/fd && \
    rm -rf /var/lib/apt/lists/*
COPY pi-start.sh /usr/local/bin/pi-start.sh
RUN chmod +x /usr/local/bin/pi-start.sh
COPY --chown=agent:agent extensions/ /home/agent/.pi/agent/extensions/
COPY --chown=agent:agent CLAUDE.md /home/agent/.pi/agent/CLAUDE.md

# Installed as agent so the npm prefix stays agent-owned and the
# `pi update --self` that pi-start.sh runs on every launch works without root.
# Unpinned: the version here is only the starting point for that update.
USER agent
RUN node --version && \
    npm install -g @earendil-works/pi-coding-agent && \
    pi --version
ARG UV_VERSION=0.12.18
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh && \
    ~/.local/bin/uv tool install ruff

ENV OMLX_PORT=8010
ENTRYPOINT ["/usr/local/bin/pi-start.sh"]
# Clears any CMD inherited from the base, which would otherwise reach
# pi-start.sh as an argument and be passed on to Pi as a prompt.
CMD []
