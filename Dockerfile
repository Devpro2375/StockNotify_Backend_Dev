# ── Railway Dockerfile: Node.js 18 + Python 3.12 ──
# Stage 1: Build Python venv with Python 3.12 (upstox-totp requires >=3.12)
FROM python:3.12-slim AS python-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc && \
    rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY python-scripts/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /tmp/requirements.txt

# Stage 2: Node.js runtime with the pre-built Python venv
FROM node:18-slim

# Install Python 3.12 runtime (no pip/venv needed — venv is pre-built)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      libstdc++6 && \
    rm -rf /var/lib/apt/lists/*

# Copy pre-built venv from Stage 1 (includes Python 3.12 + all deps)
COPY --from=python-builder /opt/venv /opt/venv
COPY --from=python-builder /usr/local/lib/libpython3.12* /usr/local/lib/
COPY --from=python-builder /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python-builder /usr/local/lib/python3.12 /usr/local/lib/python3.12
ENV PATH="/opt/venv/bin:$PATH"
ENV LD_LIBRARY_PATH="/usr/local/lib:$LD_LIBRARY_PATH"

WORKDIR /app

# Install Node.js dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Railway injects PORT at runtime
ENV NODE_ENV=production

CMD ["node", "app.js"]
