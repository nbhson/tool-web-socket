# Dockerfile for the WebSocket Server
FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy dependency manifest first to leverage Docker layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source
COPY . .

# Run as the unprivileged 'node' user bundled with the base image
USER node

# Expose the WebSocket port
EXPOSE 8080

# Run the server
CMD ["node", "app.js"]
