# ── Railway Dockerfile: Python 3.12 + Node.js 18 ──
# Single-stage: Python 3.12 base with Node.js 18 installed
FROM python:3.12-slim

# Install Node.js 18 + system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      gnupg \
      gcc \
      libstdc++6 && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Create Python virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Install Python dependencies (cached layer)
COPY python-scripts/requirements.txt python-scripts/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r python-scripts/requirements.txt

# Install Node.js dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Railway injects PORT at runtime
ENV NODE_ENV=production

CMD ["node", "app.js"]
