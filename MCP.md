# Messaging MCP Server

Multi-platform messaging MCP server for WhatsApp, Telegram, and Instagram. Exposes tools for searching, summarizing, and sending messages across all platforms.

**Server**: x86 at `192.168.50.142:3010` (SSE transport)

## Setup

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "messaging": {
      "type": "sse",
      "url": "http://192.168.50.142:3010/sse",
      "headers": {
        "Authorization": "Bearer 5UyoEnAQRtzisPouXoMy_TAhkF6zUBZCu5RCYOnzLPI"
      }
    }
  }
}
```

### MCPorter (`~/.mcporter/mcporter.json`)

```json
{
  "messaging": {
    "transport": "sse",
    "url": "http://192.168.50.142:3010/sse",
    "headers": {
      "Authorization": "Bearer 5UyoEnAQRtzisPouXoMy_TAhkF6zUBZCu5RCYOnzLPI"
    }
  }
}
```

## Tools

### WhatsApp — Send

| Tool | Description | Required params |
|------|-------------|-----------------|
| `whatsapp_send_message` | Send text message directly | `chatId`, `text` |
| `send_file` | Send file/image/video from URL | `conversationId`, `fileUrl` |
| `forward_message` | Forward message to another chat | `chatId`, `messageId`, `toChatId` |
| `delete_message` | Delete own message | `chatId`, `messageId` |

### WhatsApp — Read

| Tool | Description | Required params |
|------|-------------|-----------------|
| `list_conversations` | List chats with optional search | (optional: `type`, `query`, `limit`) |
| `search_messages` | Search by keyword or semantic query | `query` |
| `get_chat` | Chat details + recent messages | `chatId` |
| `get_context` | Messages around a specific message | `chatId`, `messageId` |
| `get_user_messages` | Messages from a specific user | `waUserId` |
| `search_users` | Search users by name/phone | `query` |
| `get_unread_chats` | Chats with unread messages | (none) |
| `get_group_info` | Group metadata | `chatId` |
| `get_group_participants` | Group members | `chatId` |
| `download_media` | Download photo/video/doc | `chatId`, `messageId` |
| `mark_as_read` | Mark chat as read | `chatId` |

### WhatsApp — AI (LiteLLM)

| Tool | Description | Required params |
|------|-------------|-----------------|
| `summarize_chat` | AI conversation summary | `chatId` |
| `summarize_day` | Summary of all chats for a day | `date` |
| `summarize_week` | Weekly summary | `weekStartDate` |
| `draft_reply` | Generate draft reply with AI | `chatId` |

### WhatsApp — Draft Flow

| Tool | Description | Required params |
|------|-------------|-----------------|
| `list_drafts` | List drafts for a chat | `chatId` |
| `approve_draft` | Approve draft for sending | `draftId` |
| `send_approved_reply` | Send approved draft | `sendToken` |

### WhatsApp — System

| Tool | Description |
|------|-------------|
| `get_me` | Authenticated WA account info |
| `get_connection_status` | WA connection status + QR |
| `whatsapp_repair_group_session` | Refresh group metadata/session state before sending |
| `renew_qr_code` | Disconnect and generate new QR |
| `messaging_status` | Health of all connectors |

### WhatsApp — Manual Send Verification

After deploy, verify direct and group sends through the MCP tool path:

```bash
whatsapp_send_message chatId='31617840208@c.us' text='MCP send smoke test'
whatsapp_repair_group_session groupId='120363043522933099@g.us'
whatsapp_send_message chatId='120363043522933099@g.us' text='MCP group send smoke test'
whatsapp_repair_group_session groupId='31611848681-1598895615@g.us'
whatsapp_send_message chatId='31611848681-1598895615@g.us' text='MCP group send smoke test'
```

Connector logs should show `failureClass=timeout`, `failureClass=missing_session`, `failureClass=disabled_sending`, or `failureClass=disconnected` instead of a generic send failure.

### Telegram — Send

| Tool | Description | Required params |
|------|-------------|-----------------|
| `telegram_send_message` | Send text message | `chatId`, `text` |
| `telegram_send_file` | Send file/photo/video | `chatId`, `filePath` |
| `telegram_forward_message` | Forward message | `fromChatId`, `messageId`, `toChatId` |
| `telegram_delete_message` | Delete message | `chatId`, `messageId` |
| `telegram_mark_as_read` | Mark chat as read | `chatId` |

### Telegram — Read

| Tool | Description | Required params |
|------|-------------|-----------------|
| `telegram_search` | Search messages | `query` |
| `telegram_get_messages` | Get messages from a chat | `chatId` |
| `telegram_chat_info` | Chat metadata | `chatId` |
| `telegram_participants` | Group members | `chatId` |
| `telegram_get_dialogs` | List all chats | (none) |
| `telegram_get_unread` | Chats with unread messages | (none) |
| `telegram_download_media` | Download media | `chatId`, `messageId` |

### Telegram — System

| Tool | Description |
|------|-------------|
| `telegram_get_status` | Connection status |
| `telegram_get_me` | Authenticated account info |

### Instagram

| Tool | Description | Required params |
|------|-------------|-----------------|
| `instagram_get_profile` | Account profile | `account` |
| `instagram_get_media` | Published posts/reels | `account` |
| `instagram_get_comments` | Post comments | `account`, `mediaId` |
| `instagram_reply_comment` | Reply to comment | `account`, `commentId`, `message` |
| `instagram_get_conversations` | DM conversations | `account` |
| `instagram_send_dm` | Send DM | `account`, `recipientId`, `message` |
| `instagram_get_stories` | Active stories | `account` |
| `instagram_publish` | Publish to Instagram | `account`, `imageUrl`, `caption` |
| `instagram_media_insights` | Post metrics | `account`, `mediaId` |

## LLM Configuration

AI tools (summarize, draft) use a configurable LLM backend:

```
LLM_BASE_URL=http://192.168.50.142:4000/v1   # LiteLLM proxy
LLM_CHAT_MODEL=litellm/tooling               # Qwen3.5-35B
```

Falls back to OpenAI `gpt-4o-mini` if not set.

## Architecture

```
Client (Claude Code / MCPorter)
  └─ SSE ──► MCP Server (:3010)
                ├─ WhatsApp Connector (:3001)
                ├─ Telegram Connector (:3002)
                ├─ Instagram Connector (:3003)
                ├─ PostgreSQL (pgvector)
                ├─ Redis (caching)
                └─ LiteLLM Proxy (:4000)
```
