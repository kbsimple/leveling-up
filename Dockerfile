FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# tconnectsync caches Tandem login tokens under $HOME/.config; keep them on
# the volume so restarts don't force a fresh login.
ENV HOME=/data \
    PYTHONUNBUFFERED=1 \
    CONTROL_HOST=0.0.0.0 \
    CONTROL_PORT=8787
VOLUME /data
EXPOSE 8787

CMD ["leveling-up", "run"]
