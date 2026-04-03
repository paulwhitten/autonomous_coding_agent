# Autonomous Copilot Agent - Docker Image
# Connects to Copilot CLI running on host machine
#
# Build args to install optional language toolchains:
#   docker build --build-arg INSTALL_PYTHON=true \
#                --build-arg INSTALL_RUST=true   \
#                --build-arg INSTALL_GO=true     \
#                --build-arg INSTALL_JAVA=true   \
#                -f docker/Dockerfile .

FROM node:20-slim

# Optional language install flags (default: false)
ARG INSTALL_PYTHON=false
ARG INSTALL_RUST=false
ARG INSTALL_GO=false
ARG INSTALL_JAVA=false

# Go version to install (when INSTALL_GO=true)
ARG GO_VERSION=1.23.6

# ── Base packages ────────────────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git openssh-client build-essential curl ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# ── Python 3 ─────────────────────────────────────────────────────────
RUN if [ "$INSTALL_PYTHON" = "true" ]; then \
        apt-get update && \
        apt-get install -y --no-install-recommends \
            python3 python3-pip python3-venv python3-dev && \
        apt-get clean && \
        rm -rf /var/lib/apt/lists/* && \
        python3 -m pip install --break-system-packages --no-cache-dir \
            pip setuptools wheel && \
        ln -sf /usr/bin/python3 /usr/bin/python; \
    fi

# ── Rust (via rustup) ───────────────────────────────────────────────
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
ENV PATH=$CARGO_HOME/bin:$PATH
RUN if [ "$INSTALL_RUST" = "true" ]; then \
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
            | sh -s -- -y --default-toolchain stable --profile default && \
        rustc --version && cargo --version; \
    fi

# ── Go ───────────────────────────────────────────────────────────────
RUN if [ "$INSTALL_GO" = "true" ]; then \
        ARCH=$(dpkg --print-architecture) && \
        curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
            | tar -C /usr/local -xzf - && \
        /usr/local/go/bin/go version; \
    fi
ENV PATH=/usr/local/go/bin:$PATH

# ── Java (OpenJDK 17) ───────────────────────────────────────────────
RUN if [ "$INSTALL_JAVA" = "true" ]; then \
        apt-get update && \
        apt-get install -y --no-install-recommends \
            default-jdk default-jre maven && \
        apt-get clean && \
        rm -rf /var/lib/apt/lists/* && \
        java -version; \
    fi

# ── Application ─────────────────────────────────────────────────────
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY roles.json ./

# Build TypeScript
RUN npm run build

# Create directory structure for volumes
RUN mkdir -p /app/workspace /app/mailbox /app/logs

# Set environment defaults
ENV NODE_ENV=production
ENV COPILOT_CLI_URL=""

# Run the agent
CMD ["node", "dist/index.js"]
