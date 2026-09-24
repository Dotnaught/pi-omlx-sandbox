# Pi at the latest upstream release (rebuilt nightly), fd, and an agent-owned
# npm prefix so `pi update --self` works without root. pi-start.sh runs that
# update on every launch, so the tag is left floating.
FROM sbx/pi-image:latest

USER root
COPY pi-start.sh /usr/local/bin/pi-start.sh
RUN chmod +x /usr/local/bin/pi-start.sh
COPY --chown=agent:agent extensions/ /home/agent/.pi/agent/extensions/
COPY --chown=agent:agent CLAUDE.md /home/agent/.pi/agent/CLAUDE.md

USER agent
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    ~/.local/bin/uv tool install ruff

ENV OMLX_PORT=8010
ENTRYPOINT ["/usr/local/bin/pi-start.sh"]
# The base image's CMD ["pi"] would otherwise reach pi-start.sh as an argument
# and be passed on to Pi as a prompt.
CMD []
