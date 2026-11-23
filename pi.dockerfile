# The plain shell template, not the -docker variant sbx/pi-image builds on: that
# one starts a Docker engine that runs for the sandbox's lifetime, and setting
# com.docker.sandboxes.start-docker=false on top of it breaks sandbox startup.
# Pinned by digest; bump it deliberately to take template updates.
ARG BASE_DIGEST=sha256:7a248c96459694d181d9d51ffc9e530c0b9a4cb3d1887cc070425336b1fb5115
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
ARG UV_VERSION=0.13.9
ARG RUFF_VERSION=0.17.6
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh && \
    ~/.local/bin/uv tool install "ruff==${RUFF_VERSION}"

ENV OMLX_PORT=8010
ENTRYPOINT ["/usr/local/bin/pi-start.sh"]
# Clears any CMD inherited from the base, which would otherwise reach
# pi-start.sh as an argument and be passed on to Pi as a prompt.
CMD []
