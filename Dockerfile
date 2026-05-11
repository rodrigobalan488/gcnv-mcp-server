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
FROM node:18-slim

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy only the built files and production dependencies from the builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install only production dependencies to keep the image small
RUN npm install --omit=dev

# The MCP server usually runs via stdio or HTTP. 
# Defaulting to the entry point defined in your package.json.
# Adjust the command if you need to pass specific flags like --transport sse
ENTRYPOINT ["node", "dist/index.js"]
