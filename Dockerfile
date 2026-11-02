# NaN Builders VS Code Extension — Docker test sandbox
# Usage: docker build -t nan-vscode-test .
#        docker run --rm nan-vscode-test

FROM node:26-bookworm

# Install VS Code dependencies for testing
RUN apt-get update && apt-get install -y \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source and test files
COPY . .

# Run compile, lint, and unit tests (integration tests require display)
RUN npm run compile && npm run lint && npm run test:unit

# Package the extension
RUN npm run package && ls -la *.vsix

# Print success
RUN echo "✅ All checks passed. Extension packaged successfully."