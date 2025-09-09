#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 MCP HTTP Agent MD - Quick Install Script${NC}"
echo -e "${YELLOW}This script will install MCP HTTP Agent MD to ~/.config/mcp-http-agent-md${NC}"
echo

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed. Please install Node.js and npm first.${NC}"
    exit 1
fi

# Check if git is available
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ git is not installed. Please install git first.${NC}"
    exit 1
fi

INSTALL_DIR="$HOME/.config/mcp-http-agent-md"

# Check if installation already exists
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Existing installation found at $INSTALL_DIR${NC}"
    echo -e "${BLUE}📦 Updating existing installation...${NC}"
    cd "$INSTALL_DIR"
    
    # Try to pull latest changes
    if ! git pull; then
        echo -e "${RED}❌ Failed to update existing installation. Please resolve git conflicts manually or remove the directory.${NC}"
        echo -e "${YELLOW}⚠️  WARNING: Removing $INSTALL_DIR will delete all your data including projects and databases!${NC}"
        echo -e "${YELLOW}💾 Backup your data first: cp -r $INSTALL_DIR/data ~/mcp-agent-backup${NC}"
        echo -e "${YELLOW}Then remove: rm -rf $INSTALL_DIR${NC}"
        exit 1
    fi
else
    # Clone the repository
    echo -e "${BLUE}📦 Cloning repository...${NC}"
    git clone https://github.com/benhaotang/mcp-http-agent-md.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo -e "${BLUE}📦 Installing dependencies...${NC}"
npm install

# Setup environment file
echo -e "${BLUE}⚙️  Setting up environment...${NC}"
cp .env.example .env

# Generate a random API key for MAIN_API_KEY
MAIN_API_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)
sed -i.bak "s/MAIN_API_KEY=xxxx/MAIN_API_KEY=$MAIN_API_KEY/" .env
rm .env.bak 2>/dev/null || true

# Start the server in background
echo -e "${BLUE}🚀 Starting server...${NC}"
npm start &
SERVER_PID=$!

# Wait for server to start
echo -e "${YELLOW}⏳ Waiting for server to start...${NC}"

# Check if server is responding
echo -e "${YELLOW}🔍 Checking server health...${NC}"
sleep 5
for i in {1..10}; do
    if curl -s http://localhost:3000/auth >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Server is ready!${NC}"
        break
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}❌ Server failed to start after 15 seconds${NC}"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# Create a user
echo -e "${BLUE}👤 Creating user...${NC}"
USER_RESPONSE=$(curl -s -X POST http://localhost:3000/auth/users \
  -H "Authorization: Bearer $MAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"user\"}" || echo "")

if [ -z "$USER_RESPONSE" ]; then
    echo -e "${RED}❌ Failed to create user. Please check if the server is running.${NC}"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Extract API key from response
USER_API_KEY=$(echo "$USER_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)

if [ -z "$USER_API_KEY" ]; then
    echo -e "${RED}❌ Failed to extract user API key from server response.${NC}"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Stop the background server
kill $SERVER_PID 2>/dev/null || true

sleep 2

echo
echo -e "${GREEN}✅ Installation complete!${NC}"
echo
echo -e "${BLUE}📋 Your MCP endpoint:${NC}"
echo -e "${GREEN}http://localhost:3000/mcp?apiKey=$USER_API_KEY${NC}"
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
echo -e "${BLUE}🖥️  Start the server from anywhere:${NC}"
echo -e "${GREEN}cd ~/.config/mcp-http-agent-md && npm start${NC}"
echo
echo -e "${BLUE}📖 Enable subagents (optional):${NC}"
echo -e "Edit ${YELLOW}~/.config/mcp-http-agent-md/.env${NC} and set:"
echo -e "  ${YELLOW}USE_EXTERNAL_AI=true${NC}"
echo -e "  ${YELLOW}AI_API_TYPE=google${NC} (or openai/groq/compat/mcp)"
echo -e "  ${YELLOW}AI_API_KEY=your-api-key${NC}"
echo
echo -e "Or export environment variables. See README for details."
echo
echo -e "${GREEN}🎉 Ready to use! Start the server and connect your MCP client.${NC}"