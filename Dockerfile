FROM node:20-slim

ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates zip && \
    rm -rf /var/lib/apt/lists/*

ARG TEMURIN_VERSION=25.0.3+9
RUN curl -fsSL "https://api.adoptium.net/v3/binary/latest/25/ga/linux/aarch64/jre/hotspot/normal/eclipse?project=jdk" \
      -o /tmp/jre.tar.gz && \
    mkdir -p /opt/java && \
    tar -xzf /tmp/jre.tar.gz -C /opt/java --strip-components=1 && \
    rm /tmp/jre.tar.gz

ENV JAVA_HOME=/opt/java
ENV PATH="/opt/java/bin:${PATH}"

ARG SIGNAL_CLI_VERSION=0.14.5
ARG LIBSIGNAL_VERSION=0.94.4

RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      -o /tmp/signal-cli.tar.gz && \
    tar -xzf /tmp/signal-cli.tar.gz -C /opt && \
    rm /tmp/signal-cli.tar.gz

RUN curl -fsSL "https://github.com/exquo/signal-libs-build/releases/download/libsignal_v${LIBSIGNAL_VERSION}/libsignal_jni.so-v${LIBSIGNAL_VERSION}-aarch64-unknown-linux-gnu.tar.gz" \
      -o /tmp/libsignal-aarch64.tar.gz && \
    tar -xzf /tmp/libsignal-aarch64.tar.gz -C /tmp && \
    cp /tmp/libsignal_jni.so /tmp/libsignal_jni_aarch64.so && \
    cd "/opt/signal-cli-${SIGNAL_CLI_VERSION}/lib" && \
    zip -d "libsignal-client-${LIBSIGNAL_VERSION}.jar" 'libsignal_jni*' && \
    zip -j "libsignal-client-${LIBSIGNAL_VERSION}.jar" /tmp/libsignal_jni_aarch64.so && \
    rm /tmp/libsignal-aarch64.tar.gz /tmp/libsignal_jni.so /tmp/libsignal_jni_aarch64.so

RUN ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/

RUN mkdir -p data/auth_info data/signal
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD test -S /tmp/signald.sock || exit 1

CMD ["node", "src/index.js"]
