# Dockerfile for the Chat UI (static files served by nginx)
FROM node:22-slim AS build

# WebSocket URL baked into the served page (defaults to localhost for dev).
# Override with: docker compose build --build-arg WS_URL=ws://chat.example.com
ARG WS_URL=ws://localhost:8080

# Set working directory
WORKDIR /app

# Copy static assets
COPY . .

# Inject the WS_URL override so the client connects to the right server
# when the UI is served from a different origin than the WebSocket server.
RUN sed -i "s|</head>|<script>window.WS_URL = '${WS_URL}';</script></head>|" /app/index.html

# Use a lightweight static server
FROM nginx:alpine

# Copy static files into nginx's default serving directory
COPY --from=build /app /usr/share/nginx/html

# Expose port 80
EXPOSE 80
