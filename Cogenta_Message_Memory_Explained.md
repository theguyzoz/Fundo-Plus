# How Cogenta Remembers Previous Messages

## Overview
Cogenta maintains conversation history **in-memory** using a JavaScript `Map` data structure. This allows the bot to reference previous messages within the same conversation session, enabling contextual responses.

---

## Core Memory System

### 1. **In-Memory History Storage** (`commands/ai.js`)

```javascript
const histories   = new Map();
const MAX_HISTORY = 10;
```

**Key Details:**
- **Data Structure**: JavaScript `Map` object with JID (WhatsApp user ID) as keys
- **Max History**: Keeps up to **10 message exchanges** (20 total messages: 10 user + 10 assistant)
- **Scope**: Session-based (lost when bot restarts)
- **Per-User**: Each WhatsApp contact has their own separate conversation history

### 2. **History Management Functions**

#### Getting History
```javascript
function getHistory(jid) {
  if (!histories.has(jid)) histories.set(jid, []);
  return histories.get(jid);
}
```
- Retrieves existing history for a JID
- Creates empty array if user is new

#### Pushing Messages to History
```javascript
function pushHistory(jid, role, content) {
  const h = getHistory(jid);
  h.push({ role, content });
  while (h.length > MAX_HISTORY * 2) h.splice(0, 2);
}
```
- Adds new message (user or assistant) to the history
- **Auto-prunes**: Removes oldest 2 messages when exceeding 20 total messages
- Each message stored as: `{ role: "user" | "assistant", content: "message text" }`

---

## How Messages are Stored and Sent to AI

### Message Flow

```
User sends message
    ↓
extractBody() - Extract text from WhatsApp message
    ↓
askAI(jid, userMessage) - Main AI function
    ↓
tryGemini/tryGroq/tryDeepSeek() - Provider functions
    ↓
pushHistory() - Store user message
    ↓
AI API returns response
    ↓
pushHistory() - Store assistant response
    ↓
Send reply to user
```

### Example: Building API Request with History

**For Gemini API:**
```javascript
async function tryGemini(jid, userMessage) {
  const history = getHistory(jid);
  const geminiContents = history.map(h => ({
    role : h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));
  geminiContents.push({ role: 'user', parts: [{ text: userMessage }] });
  // Send to API with full history...
}
```

**For Groq/DeepSeek APIs:**
```javascript
async function tryGroq(jid, userMessage) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(jid).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];
  // Send to API with system prompt + full history...
}
```

**Key Point:** Every time a user sends a message, the entire conversation history is sent to the AI API, allowing the AI to maintain context.

---

## Conversation History Example

### User Chat Flow
```
User: "What is photosynthesis?"
Bot: "Photosynthesis is the process..."
  [History: [{role: "user", content: "What is photosynthesis?"}, 
             {role: "assistant", content: "Photosynthesis is..."}]]

User: "Can you explain it simply?"
Bot: "Sure! In simple terms..."
  [History: [{role: "user", content: "What is photosynthesis?"}, 
             {role: "assistant", content: "Photosynthesis is..."},
             {role: "user", content: "Can you explain it simply?"},
             {role: "assistant", content: "Sure! In simple terms..."}]]

User: "What about chlorophyll?"
Bot: "Chlorophyll is the pigment in plants..."
  [Full conversation is remembered and sent with each request]
```

---

## Memory Limits & Behavior

### History Truncation
- **Maximum stored**: 10 messages from user + 10 from bot = 20 total
- **Oldest messages pruned first**: When exceeding 20 messages, deletes the 2 oldest entries
- **Per-conversation**: Each WhatsApp contact maintains independent history

### When History Resets

1. **Bot Restart**: All in-memory history lost (entire `Map` cleared)
2. **User Command `/clear`**: 
   ```javascript
   export function clearHistory(jid) { 
     histories.delete(jid); 
   }
   ```
   Clears specific user's history

3. **Admin Command `.refresh`**: 
   ```javascript
   clearAllHistories();
   ```
   Clears all users' histories

### User Awareness
```
User can type: /clear
Bot responds: 🗑️ Chat history cleared! Fresh start 🌱
```

---

## Multi-Provider Fallback with Memory

Cogenta supports 3 AI providers with fallback:

1. **Primary**: Google Gemini 2.5 Flash
2. **Fallback 1**: Groq (llama-3.1-8b-instant)
3. **Fallback 2**: DeepSeek

**Memory Behavior:**
- All providers access the **same conversation history** from the `Map`
- If Gemini fails, Groq/DeepSeek can continue the conversation using the same context
- History stored regardless of which provider responds

---

## System Architecture

### File Structure
```
commands/
  ├── main.js        → Routes messages, calls askAI()
  ├── ai.js          → Manages history, calls AI providers
  └── ...
```

### Key Export from `ai.js`
```javascript
export async function askAI(jid, userMessage) {
  // Try providers in order
  // Store message and response in history
  // Return AI reply
}

export function clearHistory(jid) { /* ... */ }
export function clearAllHistories() { /* ... */ }
```

### Integration in `main.js`
```javascript
import { askAI, clearHistory, clearAllHistories } from './ai.js';

// In message handler:
const reply = await askAI(jid, body);
// In /clear command:
clearHistory(jid);
```

---

## Important Limitations

### What Cogenta CANNOT Remember
✗ Messages from previous bot restarts
✗ Data persisted to disk (no database used for chat history)
✗ Conversation history in other WhatsApp groups/chats
✗ Messages older than 10 exchanges (20 messages)
✗ Context after a user manually clears history

### What Cogenta CAN Remember
✓ Up to 10 message exchanges in current session
✓ Context across different AI providers (Gemini → Groq fallback)
✓ Tone and style preferences established in conversation
✓ Prior questions referenced in the same chat
✓ Any information the user provided earlier

---

## Code Flow Diagram

```
WhatsApp Message Received
         ↓
   extractBody()
         ↓
   handleMessage() [main.js]
         ↓
   askAI(jid, userMessage) [ai.js]
         ↓
   getHistory(jid)  ← Retrieve previous messages
         ↓
   Try Gemini/Groq/DeepSeek with full history
         ↓
   pushHistory(jid, 'user', userMessage)   ← Store user msg
   pushHistory(jid, 'assistant', reply)     ← Store AI reply
         ↓
   Return reply to main.js
         ↓
   handleAiReply() [main.js]
         ↓
   Send response to WhatsApp user
```

---

## Configuration Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_HISTORY` | 10 | Max exchanges before pruning |
| `DAILY_CHAT_LIMIT` | 50 | Daily messages per user (usage tracking) |
| `SYSTEM_PROMPT` | [See ai.js] | Bot personality & instructions |

---

## Summary

**Cogenta remembers previous messages through:**
1. **In-memory Map storage** keyed by WhatsApp JID
2. **Automatic history management** (keeps last 10 exchanges)
3. **Full conversation context** sent with each AI request
4. **Per-user isolation** (each contact has separate history)
5. **Manual reset options** (`/clear` command or `.refresh` admin command)

This approach prioritizes **fast, contextual responses** over persistent storage, making Cogenta feel like a natural conversation while keeping the system simple and responsive.
