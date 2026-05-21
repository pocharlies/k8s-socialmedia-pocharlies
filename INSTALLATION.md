# WhatsApp MCP Server Installation Guide

This guide explains how to install and configure the WhatsApp MCP Server for use with Claude Desktop and Claude CLI.

## Prerequisites

- Docker and Docker Compose installed
- Node.js 20+ and pnpm installed (for local development)
- PostgreSQL, Redis, NATS, and MinIO (provided via Docker Compose)

## Setup

1. **Clone and configure the project:**

```bash
cd /path/to/whatsappmcp
cp .env.example .env
# Edit .env with your configuration
```

2. **Start the services:**

```bash
docker compose up -d
```

3. **Run database migrations:**

```bash
cd mcp-server
pnpm db:migrate
```

## Installation for Claude Desktop

### macOS/Linux

1. **Locate your Claude Desktop config file:**

```bash
# macOS
~/Library/Application Support/Claude/claude_desktop_config.json

# Linux
~/.config/Claude/claude_desktop_config.json
```

2. **Add the WhatsApp MCP Server configuration:**

```json
{
  "mcpServers": {
    "whatsapp-mcp": {
      "command": "node",
      "args": ["/home/ubuntu/whatsappmcp/mcp-server/dist/mcp/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "your-openai-api-key",
        "ENCRYPTION_KEY": "your-encryption-key",
        "CONNECTOR_SHARED_SECRET": "your-shared-secret",
        "CONNECTOR_URL": "http://localhost:3001"
      }
    }
  }
}
```

3. **Build the MCP server:**

```bash
cd /home/ubuntu/whatsappmcp/mcp-server
pnpm build
```

4. **Restart Claude Desktop**

### Windows

1. **Locate your Claude Desktop config file:**

```
%APPDATA%\Claude\claude_desktop_config.json
```

2. **Add the configuration (adjust paths for Windows):**

```json
{
  "mcpServers": {
    "whatsapp-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\whatsappmcp\\mcp-server\\dist\\mcp\\index.js"],
      "env": {
        "DATABASE_URL": "postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "your-openai-api-key",
        "ENCRYPTION_KEY": "your-encryption-key",
        "CONNECTOR_SHARED_SECRET": "your-shared-secret",
        "CONNECTOR_URL": "http://localhost:3001"
      }
    }
  }
}
```

## Installation for Claude CLI

1. **Locate your Claude CLI config file:**

```bash
# macOS/Linux
~/.config/claude/config.json

# Windows
%USERPROFILE%\.config\claude\config.json
```

2. **Add the WhatsApp MCP Server configuration:**

```json
{
  "mcpServers": {
    "whatsapp-mcp": {
      "command": "node",
      "args": ["/home/ubuntu/whatsappmcp/mcp-server/dist/mcp/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp",
        "REDIS_URL": "redis://localhost:6379",
        "OPENAI_API_KEY": "your-openai-api-key",
        "ENCRYPTION_KEY": "your-encryption-key",
        "CONNECTOR_SHARED_SECRET": "your-shared-secret",
        "CONNECTOR_URL": "http://localhost:3001"
      }
    }
  }
}
```

3. **Verify the installation:**

```bash
claude mcp list
```

## Available MCP Tools

Once installed, you'll have access to these tools in Claude:

### Connection Management

- `get_connection_status` - Check WhatsApp connection status
- `renew_qr_code` - Generate a new QR code for authentication

### Message Search & Retrieval

- `search_messages` - Search messages by keyword or semantic query
- `get_chat` - Get conversation details and recent messages
- `get_context` - Get message context with surrounding messages

### Summarization

- `summarize_chat` - Generate summary of a conversation
- `summarize_day` - Summarize all conversations for a specific day
- `summarize_week` - Summarize all conversations for a week

### Draft Management

- `draft_reply` - Draft a reply to a message or conversation
- `list_drafts` - List draft replies for a conversation
- `approve_draft` - Approve a draft reply and generate send token
- `send_approved_reply` - Send an approved reply (requires feature flag)

## Authentication with WhatsApp

1. **Check connection status:**

```
Ask Claude: "What's the WhatsApp connection status?"
```

2. **Generate QR code (if needed):**

```
Ask Claude: "Renew the WhatsApp QR code"
```

3. **Scan the QR code:**
   - Visit https://whatsapp.e-dani.com/ (or your configured URL)
   - Scan with WhatsApp: Settings → Linked Devices → Link a Device

## Troubleshooting

### MCP Server not appearing in Claude

1. Check that the build was successful:

```bash
cd /home/ubuntu/whatsappmcp/mcp-server
pnpm build
ls -la dist/mcp/index.js
```

2. Verify the config file path is correct
3. Check Claude Desktop/CLI logs for errors
4. Restart Claude Desktop/CLI

### Connection issues

1. Verify services are running:

```bash
docker compose ps
```

2. Check database connectivity:

```bash
psql postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp -c "SELECT 1"
```

3. Check WhatsApp connector logs:

```bash
docker logs whatsappmcp-whatsapp-connector-1
```

### QR Code not showing

1. Check if WhatsApp is already connected:

```
Ask Claude: "What's the WhatsApp connection status?"
```

2. If connected, renew QR code:

```
Ask Claude: "Renew the WhatsApp QR code with confirmDisconnect true"
```

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `OPENAI_API_KEY` - OpenAI API key for embeddings and summarization
- `ENCRYPTION_KEY` - Key for encrypting message content
- `CONNECTOR_SHARED_SECRET` - Shared secret for HMAC authentication
- `CONNECTOR_URL` - WhatsApp connector API URL
- `ENABLE_SENDING` - Set to 'true' to enable message sending
- `EMERGENCY_DISABLE_SENDING` - Emergency kill switch for sending

## Security Notes

- Store sensitive credentials securely
- Use strong encryption keys
- Never commit `.env` files to version control
- Restrict database and API access
- Enable message sending only when needed
