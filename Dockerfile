# --- Stage 1: Build Stage ---
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for building)
RUN npm install

# Copy the rest of the source code
COPY . .

# Build the TypeScript project
RUN npm run build

# --- Stage 2: Production Stage ---
# --- Stage 2: Production Stage ---
FROM node:18-slim

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
# Set the port as an environment variable (standard practice)
ENV PORT=8080

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

RUN npm install --omit=dev

# Inform Docker that the container listens on the specified port at runtime
EXPOSE 8080

# Change the command to use SSE transport so it listens for HTTP traffic
CMD ["node", "dist/index.js", "--transport", "sse"]
