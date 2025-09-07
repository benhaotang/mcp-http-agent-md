FROM node:20-alpine AS base


# Enable corepack so pnpm works from packageManager field
RUN corepack enable

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./

# Install production deps (no lockfile provided; allow resolution)
RUN pnpm install --prod --no-optional --frozen-lockfile=false

# Copy the rest of the application
COPY . .

# Ensure the server binds externally inside the container
ENV HOST=0.0.0.0
ENV PORT=3000
ENV BASE_PATH=/mcp

# Persist the embedded SQLite file DB
VOLUME ["/app/data"]

EXPOSE 3000

# Start the server (same as `pnpm start` -> node index.js)
CMD ["node", "index.js"]

