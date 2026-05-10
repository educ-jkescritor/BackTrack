FROM bitnami/kubectl:latest AS kubectl
FROM docker:latest AS docker-cli

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy kubectl and docker CLI from official images — no apt bloat
COPY --from=kubectl /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

RUN mkdir -p /data

ARG AGENT_PORT=8847
ENV AGENT_PORT=${AGENT_PORT}
EXPOSE ${AGENT_PORT}

CMD uvicorn src.main:app --host 0.0.0.0 --port ${AGENT_PORT}
