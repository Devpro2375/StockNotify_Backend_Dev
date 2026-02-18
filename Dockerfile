# ── Railway Dockerfile: Node.js 18 + Python 3.12 ──
FROM node:18-slim

# Install Python 3 and pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      gcc \
      libstdc++6 && \
    rm -rf /var/lib/apt/lists/*

# Create Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Install Python dependencies first (cached layer)
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
