#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🐳 MCP HTTP Agent MD - Docker Quick Install${NC}"
echo -e "${YELLOW}This script will run MCP HTTP Agent MD in Docker with persistent data${NC}"
echo

# Check if docker is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Check if curl is available
if ! command -v curl &> /dev/null; then
    echo -e "${RED}❌ curl is not installed. Please install curl first.${NC}"
    exit 1
fi

DATA_DIR="$HOME/.config/mcp-http-agent-md/data"
CONTAINER_NAME="mcp-http-agent-md"

# Create data directory if it doesn't exist
if [ ! -d "$DATA_DIR" ]; then
    echo -e "${BLUE}📁 Creating data directory at $DATA_DIR${NC}"
    mkdir -p "$DATA_DIR"
fi

# Stop and remove existing container if it exists
if docker ps -a --format 'table {{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}⚠️  Stopping existing container...${NC}"
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

# Generate a random API key for MAIN_API_KEY
MAIN_API_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)

echo -e "${BLUE}📦 Pulling latest Docker image...${NC}"
docker pull ghcr.io/benhaotang/mcp-http-agent-md:latest

echo -e "${BLUE}🚀 Starting Docker container...${NC}"
docker run -d --restart always \
  -p 3000:3000 \
  -e MAIN_API_KEY="$MAIN_API_KEY" \
  -e HOST=0.0.0.0 \
  -v "$DATA_DIR":/app/data \
  --name "$CONTAINER_NAME" \
  ghcr.io/benhaotang/mcp-http-agent-md:latest

# Wait for container to start
echo -e "${YELLOW}⏳ Waiting for container to start...${NC}"
sleep 5

# Check if container is running
if ! docker ps --format 'table {{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}❌ Container failed to start. Check logs with: docker logs $CONTAINER_NAME${NC}"
    exit 1
fi

# Create a user
echo -e "${BLUE}👤 Creating user...${NC}"
USER_RESPONSE=$(curl -s -X POST http://localhost:3000/auth/users \
  -H "Authorization: Bearer $MAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"user\"}" || echo "")

if [ -z "$USER_RESPONSE" ]; then
    echo -e "${RED}❌ Failed to create user. Please check if the container is running.${NC}"
    echo -e "${YELLOW}Check container status: docker ps${NC}"
    echo -e "${YELLOW}Check container logs: docker logs $CONTAINER_NAME${NC}"
    exit 1
fi

# Extract API key from response
USER_API_KEY=$(echo "$USER_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)

if [ -z "$USER_API_KEY" ]; then
    echo -e "${RED}❌ Failed to extract user API key from server response.${NC}"
    exit 1
fi

echo
echo -e "${GREEN}✅ Docker installation complete!${NC}"
echo
echo -e "${BLUE}📋 Your MCP endpoint:${NC}"
echo -e "${GREEN}http://localhost:3000/mcp?apiKey=$USER_API_KEY${NC}"
echo
echo -e "${BLUE}🔑 Your MAIN_API_KEY (for admin access):${NC}"
echo -e "${GREEN}$MAIN_API_KEY${NC}"
echo
echo -e "${BLUE}🔧 Add to your MCP client config:${NC}"
echo -e "${YELLOW}STDIO (via mcp-remote):${NC}"
cat << EOF
{
  "mcpServers": {
    "mcp-agent-md": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp?apiKey=$USER_API_KEY"]
    }
  }
}
EOF
echo
echo -e "${YELLOW}HTTP (direct connection):${NC}"
cat << EOF
{
  "mcpServers": {
    "mcp-agent-md": {
      "url": "http://localhost:3000/mcp?apiKey=$USER_API_KEY"
    }
  }
}
EOF
echo
echo -e "${BLUE}🖥️  Container management commands:${NC}"
echo -e "${GREEN}Start:  docker start $CONTAINER_NAME${NC}"
echo -e "${GREEN}Stop:   docker stop $CONTAINER_NAME${NC}"
echo -e "${GREEN}Logs:   docker logs $CONTAINER_NAME${NC}"
echo -e "${GREEN}Remove: docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME${NC}"
echo
echo -e "${BLUE}📖 Enable subagents (optional):${NC}"
echo -e "Restart container with additional environment variables:"
echo -e "${YELLOW}docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME${NC}"
echo -e "${YELLOW}docker run -d --restart always \\${NC}"
echo -e "${YELLOW}  -p 3000:3000 \\${NC}"
echo -e "${YELLOW}  -e MAIN_API_KEY=\"$MAIN_API_KEY\" \\${NC}"
echo -e "${YELLOW}  -e HOST=0.0.0.0 \\${NC}"
echo -e "${YELLOW}  -e USE_EXTERNAL_AI=true \\${NC}"
echo -e "${YELLOW}  -e AI_API_TYPE=google \\${NC}"
echo -e "${YELLOW}  -e AI_API_KEY=your-api-key \\${NC}"
echo -e "${YELLOW}  -v \"$DATA_DIR\":/app/data \\${NC}"
echo -e "${YELLOW}  --name $CONTAINER_NAME \\${NC}"
echo -e "${YELLOW}  ghcr.io/benhaotang/mcp-http-agent-md:latest${NC}"
echo
echo -e "${GREEN}🎉 Ready to use! Your data is persisted in $DATA_DIR${NC}"