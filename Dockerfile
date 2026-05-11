# --- Stage 1: Build Stage ---
# Changed from 18-slim to 22-slim
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Stage 2: Production Stage ---
# Changed from 18-slim to 22-slim
FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app/build ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

RUN npm install --omit=dev

EXPOSE 8080

# Use the "http" string your script expects, and pass the port env var
CMD ["node", "dist/index.js", "--transport", "http"]
