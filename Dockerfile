FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends default-jre-headless curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ARG SIGNAL_CLI_VERSION=0.13.0
RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      -o /tmp/signal-cli.tar.gz && \
    tar -xzf /tmp/signal-cli.tar.gz -C /opt && \
    ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli && \
    rm /tmp/signal-cli.tar.gz

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/

RUN mkdir -p data/auth_info data/signal
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
