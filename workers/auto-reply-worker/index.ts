import { connect, NatsConnection, Subscription, JSONCodec } from "nats";
import { readFileSync } from "fs";
import { createHmac, timingSafeEqual } from "crypto";
import { Pool } from "pg";
import express from "express";

// ─── Types ───────────────────────────────────────────────────────────────────

type Platform = "whatsapp" | "telegram";

interface Rule {
  conversation_id: string;
  name: string;
  enabled: boolean;
  platform: Platform;
  language: string;
  max_replies: number;
  replies_sent: number;
  brain: "skirmshop" | "personal" | "none";
  use_history: boolean;
  soul: string;
  identity: string;
  user: string;
  memory: string;
  tools: string;
  agents: string;
  personality: string;
  smart_reply: boolean;
  emoji_reactions: boolean;
}

interface Config { rules: Rule[]; }

interface Attachment {
  type: string;       // image, audio, video, document
  url?: string;       // WhatsApp media URL
  fileId?: string;    // Telegram file ID
  mimeType?: string;
  fileName?: string;
}

interface NormalizedMessage {
  platform: Platform;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  messageId?: string;
  attachments?: Attachment[];
  messageType?: string;
}

interface DbMessage {
  sender_id: string;
  content: string;
  direction: string;
}

interface ClassificationResult {
  should_reply: boolean;
  reaction: string | null;
}

interface BufferedContext {
  messages: Array<{ content: string; timestamp: number; senderId: string }>;
  totalChars: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.CONFIG_PATH || "/app/config.json";
const NATS_URL = process.env.NATS_URL || "nats://nats:4222";
const NATS_CA_CERT = process.env.NATS_CA_CERT || "/certs/ca.crt";
const WA_DB_URL = process.env.DATABASE_URL || "postgresql://whatsappmcp:whatsappmcp_dgx_2026@postgres:5432/whatsappmcp";
const WA_CONNECTOR_URL = process.env.CONNECTOR_URL || "http://whatsapp-connector:3001/api/v1/messages/send";
const WA_CONNECTOR_SECRET = process.env.CONNECTOR_SECRET || "dev-secret-change-in-production";
const TG_BRIDGE_URL = process.env.TELEGRAM_BRIDGE_URL || "";
const TG_BRIDGE_SECRET = process.env.TELEGRAM_BRIDGE_SECRET || "telegram-bridge-secret-2026";
const LLM_URL = process.env.LLM_URL || "https://dgx.e-dani.com/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "local";
const LLM_OMNI_MODEL = process.env.LLM_OMNI_MODEL || "omni";
const LLM_OMNI_MAX_TOKENS = parseInt(process.env.LLM_OMNI_MAX_TOKENS || "500");
const REPLY_DELAY_MS = parseInt(process.env.REPLY_DELAY_MS || "2500");
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3090");

const WA_REACT_URL = WA_CONNECTOR_URL.replace(/\/messages\/send$/, "/messages/react");

const RAG_BRAINS: Record<string, string> = {
  skirmshop: process.env.RAG_SKIRMSHOP_URL || "https://rag.e-dani.com/mcp",
  personal: process.env.RAG_PERSONAL_URL || "",
};

// ─── Globals ─────────────────────────────────────────────────────────────────

let config: Config;
const replyCounters = new Map<string, number>();
const contextBuffers = new Map<string, BufferedContext>();

const BUFFER_MAX_MESSAGES = 10;
const BUFFER_MAX_CHARS = 2000;
const BUFFER_TTL_MS = 30 * 60 * 1000;

const VALID_REACTION_EMOJIS = ["❤️", "😢", "😮", "😂", "🔥", "🙏"];

function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    parsed.rules = (parsed.rules || []).map((r: any) => ({
      soul: "", identity: "", user: "", memory: "", tools: "", agents: "",
      personality: "", brain: "none", use_history: false, platform: "whatsapp",
      smart_reply: true, emoji_reactions: true,
      ...r,
    }));
    return parsed;
  } catch (err) {
    console.error("[config] Failed to load config:", err);
    process.exit(1);
  }
}

// ─── Context Buffer ──────────────────────────────────────────────────────────

function addToBuffer(conversationId: string, content: string, senderId: string): void {
  let buffer = contextBuffers.get(conversationId) || { messages: [], totalChars: 0 };
  const now = Date.now();
  buffer.messages = buffer.messages.filter(m => now - m.timestamp < BUFFER_TTL_MS);
  buffer.totalChars = buffer.messages.reduce((sum, m) => sum + m.content.length, 0);
  buffer.messages.push({ content, timestamp: now, senderId });
  buffer.totalChars += content.length;
  while (buffer.messages.length > BUFFER_MAX_MESSAGES || buffer.totalChars > BUFFER_MAX_CHARS) {
    const removed = buffer.messages.shift();
    if (removed) buffer.totalChars -= removed.content.length;
  }
  contextBuffers.set(conversationId, buffer);
}

function consumeBuffer(conversationId: string): string {
  const buffer = contextBuffers.get(conversationId);
  if (!buffer || buffer.messages.length === 0) return "";
  const now = Date.now();
  const valid = buffer.messages.filter(m => now - m.timestamp < BUFFER_TTL_MS);
  if (valid.length === 0) { contextBuffers.delete(conversationId); return ""; }
  const context = valid.map(m => m.content).join("\n");
  contextBuffers.delete(conversationId);
  return context;
}

// ─── Message Classifier ─────────────────────────────────────────────────────

async function classifyMessage(content: string, recentHistory: string): Promise<ClassificationResult> {
  const systemPrompt = `Eres un clasificador de mensajes de chat entre amigos. Analiza el mensaje y responde SOLO con JSON.

REGLA PRINCIPAL: La mayoría de mensajes en un chat NO necesitan respuesta. Solo responde true cuando sea una pregunta directa o una petición clara.

should_reply:
- TRUE SOLO si: pregunta directa con interrogación, petición explícita ("dime", "hazme", "pásame")
- FALSE si: cuenta algo de su día, comparte info, opina, narra, saluda sin preguntar, dice "ok/vale/sí/no", confirma, comenta, expresa sentimientos, dice algo gracioso, manda un link, reacciona a algo

Ejemplos FALSE: "Hoy he ido al gym", "Qué fuerte lo de ayer", "Jajaja", "Te quiero mucho", "Mira esto", "Hola qué tal" (saludo retórico), "Estoy cansado", "Me ha pasado algo increíble hoy"
Ejemplos TRUE: "Qué hora es?", "Has visto mi mensaje?", "Me recomiendas algo?", "Dónde quedamos?"

reaction: Emoji SOLO cuando la emoción sea MUY clara y fuerte. Pon reacción generosamente cuando NO contestas (si should_reply es false y hay emoción). Sé más conservador con reacciones cuando SÍ contestas.
- "❤️" → cariño/amor muy claro
- "😢" → tristeza obvia  
- "😮" → sorpresa real
- "😂" → algo gracioso
- "🔥" → algo genial/emocionante
- "🙏" → gratitud clara
- null → neutro

Responde SOLO: {"should_reply": true/false, "reaction": "emoji"/null}`;

  const userContent = recentHistory
    ? `Contexto reciente:\n${recentHistory}\n\nMensaje:\n${content}`
    : `Mensaje:\n${content}`;

  try {
    const response = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 80,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.warn(`[classify] LLM error ${response.status}, defaulting to reply`);
      return { should_reply: true, reaction: null };
    }

    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const raw = data.choices[0]?.message?.content?.trim() || "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[classify] No JSON: "${raw}", defaulting to reply`);
      return { should_reply: true, reaction: null };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      should_reply: parsed.should_reply === true,
      reaction: VALID_REACTION_EMOJIS.includes(parsed.reaction) ? parsed.reaction : null,
    };
  } catch (err) {
    console.warn(`[classify] Error:`, err);
    return { should_reply: true, reaction: null };
  }
}

// ─── DB (WhatsApp — local postgres) ──────────────────────────────────────────

const waPool = new Pool({ connectionString: WA_DB_URL });

async function fetchWaRecentMessages(conversationId: string, limit = 20): Promise<DbMessage[]> {
  try {
    const res = await waPool.query(
      `SELECT sender_wa_id as sender_id, content,
              CASE WHEN sender_wa_id = $1 THEN 'inbound' ELSE 'outbound' END as direction
       FROM messages WHERE conversation_id = $1 AND message_type = 'TEXT' AND content IS NOT NULL
       ORDER BY wa_timestamp DESC LIMIT $2`,
      [conversationId, limit]
    );
    return res.rows.reverse();
  } catch (err) {
    console.error("[db:wa] Error:", err);
    return [];
  }
}

// ─── History (Telegram — via bridge HTTP API) ────────────────────────────────

async function fetchTgRecentMessages(chatId: string, limit = 20): Promise<DbMessage[]> {
  if (!TG_BRIDGE_URL) return [];
  try {
    const body = JSON.stringify({ chat_id: chatId, limit });
    const response = await fetch(`${TG_BRIDGE_URL}/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildBridgeHmacHeaders(body) },
      body,
    });
    if (!response.ok) { console.error(`[history:tg] Bridge ${response.status}`); return []; }
    const data = await response.json() as any;
    return (data.messages || []).map((m: any) => ({
      sender_id: m.sender_id,
      content: m.content,
      direction: m.direction,
    }));
  } catch (err) {
    console.error("[history:tg] Error:", err);
    return [];
  }
}

// ─── RAG Brain ───────────────────────────────────────────────────────────────

async function queryBrain(brain: string, query: string): Promise<string> {
  if (brain === "personal" && TG_BRIDGE_URL) {
    try {
      const body = JSON.stringify({ query, limit: 5 });
      const response = await fetch(`${TG_BRIDGE_URL}/brain-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildBridgeHmacHeaders(body) },
        body,
      });
      if (!response.ok) { console.warn(`[brain] Personal brain returned ${response.status}`); return ""; }
      const data = await response.json() as any;
      if (data.context) { console.log(`[brain] Personal: ${data.count} results`); return data.context; }
      return "";
    } catch (err) { console.warn(`[brain] Personal brain query failed:`, err); return ""; }
  }

  const baseUrl = RAG_BRAINS[brain];
  if (!baseUrl) return "";
  try {
    const toolCall = {
      jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name: "chat_with_rag", arguments: { query, use_rag: true, max_tokens: 500 } },
    };
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toolCall),
    });
    if (!response.ok) return "";
    const data = await response.json() as any;
    const content = data?.result?.content;
    if (Array.isArray(content)) return content.map((c: any) => c.text || "").join("\n").trim();
    return typeof content === "string" ? content : "";
  } catch (err) { console.warn(`[brain] RAG ${brain} query failed:`, err); return ""; }
}

// ─── System Prompt Builder ───────────────────────────────────────────────────

function buildSystemPrompt(rule: Rule, brainContext: string): string {
  const sections: string[] = [];
  if (rule.soul) sections.push(`# SOUL\n${rule.soul}`);
  if (rule.identity) sections.push(`# IDENTITY\n${rule.identity}`);
  if (rule.user) sections.push(`# USER\n${rule.user}`);
  if (rule.memory) sections.push(`# MEMORY\n${rule.memory}`);
  if (rule.tools) sections.push(`# TOOLS\n${rule.tools}`);
  if (rule.agents) sections.push(`# AGENTS\n${rule.agents}`);
  if (rule.personality && !rule.soul) sections.push(rule.personality);
  if (brainContext) sections.push(`# KNOWLEDGE (from ${rule.brain} brain)\n${brainContext}`);
  const platformName = rule.platform === "telegram" ? "Telegram" : "WhatsApp";
  sections.push(`\nRespond in ${rule.language}. Keep responses concise and natural for ${platformName}.`);
  // Anti-robotic instructions
  sections.push(`IMPORTANTE: Responde como un humano real en un chat. Máximo 1-2 frases cortas. Sin emojis. Sin exclamaciones exageradas. No repitas temas que ya se han hablado. No hagas preguntas de vuelta siempre. A veces solo comenta algo breve y ya. Nunca empieces con "¡". Sé seco y natural, como un tío real escribiendo por WhatsApp.`);
  return sections.join("\n\n");
}

// ─── HMAC Auth ───────────────────────────────────────────────────────────────

function buildWaHmacHeaders(body: object): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = timestamp + ":" + JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", WA_CONNECTOR_SECRET).update(payload).digest("hex");
  return { "X-Connector-Timestamp": timestamp, "X-Connector-Signature": signature };
}

function buildBridgeHmacHeaders(body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = timestamp + ":" + body;
  const signature = "sha256=" + createHmac("sha256", TG_BRIDGE_SECRET).update(payload).digest("hex");
  return { "X-Bridge-Timestamp": timestamp, "X-Bridge-Signature": signature };
}

function verifyBridgeWebhook(timestamp: string, signature: string, body: string): boolean {
  if (!timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;
  const expected = createHmac("sha256", TG_BRIDGE_SECRET).update(`${timestamp}:${body}`).digest("hex");
  const provided = signature.replace("sha256=", "");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

// ─── Send Reply ──────────────────────────────────────────────────────────────

async function sendWhatsAppReply(conversationId: string, content: string): Promise<void> {
  const body = { sendToken: "auto-reply", conversationId, content };
  const response = await fetch(WA_CONNECTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildWaHmacHeaders(body) },
    body: JSON.stringify(body),
  });
  if (!response.ok) { const text = await response.text(); throw new Error(`WA ${response.status}: ${text}`); }
  console.log(`[send:wa] Reply sent to ${conversationId}`);
}

async function sendTelegramReply(conversationId: string, content: string): Promise<void> {
  if (!TG_BRIDGE_URL) throw new Error("TELEGRAM_BRIDGE_URL not configured");
  const body = JSON.stringify({ chat_id: conversationId, text: content });
  const response = await fetch(`${TG_BRIDGE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildBridgeHmacHeaders(body) },
    body,
  });
  if (!response.ok) { const text = await response.text(); throw new Error(`TG Bridge ${response.status}: ${text}`); }
  console.log(`[send:tg] Reply sent to ${conversationId}`);
}

// ─── Send Reaction ───────────────────────────────────────────────────────────

async function sendWhatsAppReaction(conversationId: string, messageId: string, emoji: string): Promise<void> {
  const body = { conversationId, messageId, emoji };
  const response = await fetch(WA_REACT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildWaHmacHeaders(body) },
    body: JSON.stringify(body),
  });
  if (!response.ok) console.warn(`[react:wa] Failed: ${response.status}`);
  else console.log(`[react:wa] ${emoji} on ${messageId}`);
}

async function sendTelegramReaction(conversationId: string, messageId: string, emoji: string): Promise<void> {
  if (!TG_BRIDGE_URL) return;
  const body = JSON.stringify({ chat_id: conversationId, message_id: messageId, emoji });
  const response = await fetch(`${TG_BRIDGE_URL}/react`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildBridgeHmacHeaders(body) },
    body,
  });
  if (!response.ok) console.warn(`[react:tg] Failed: ${response.status}`);
  else console.log(`[react:tg] ${emoji} on ${messageId}`);
}

// ─── Media Analysis (Qwen3-Omni) ─────────────────────────────────────────────

async function downloadMediaAsBase64(attachment: Attachment): Promise<{ data: string; mimeType: string } | null> {
  try {
    const url = attachment.url || (attachment.fileId ? `${TG_BRIDGE_URL}/file/${attachment.fileId}` : "");
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) { console.warn(`[media] Download failed: ${response.status}`); return null; }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = attachment.mimeType || response.headers.get("content-type") || "application/octet-stream";
    return { data: buffer.toString("base64"), mimeType };
  } catch (err) {
    console.warn("[media] Download error:", err);
    return null;
  }
}

function buildOmniContent(text: string, attachments: Attachment[], mediaData: Array<{ data: string; mimeType: string }>): any[] {
  const parts: any[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const media = mediaData[i];
    if (!media) continue;
    const baseType = att.type || media.mimeType.split("/")[0];
    if (baseType === "image") {
      parts.push({ type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.data}` } });
    } else if (baseType === "audio" || baseType === "voice") {
      parts.push({ type: "input_audio", input_audio: { data: media.data, format: media.mimeType.includes("ogg") ? "ogg" : "wav" } });
    } else if (baseType === "video") {
      parts.push({ type: "video_url", video_url: { url: `data:${media.mimeType};base64,${media.data}` } });
    }
  }
  if (text) parts.push({ type: "text", text });
  else if (parts.length > 0) parts.push({ type: "text", text: "Describe what you see/hear." });
  return parts;
}

async function analyzeMedia(
  rule: Rule, attachments: Attachment[], caption: string, brainContext: string
): Promise<string> {
  const mediaData = (await Promise.all(attachments.map(downloadMediaAsBase64))).filter(Boolean) as Array<{ data: string; mimeType: string }>;
  if (mediaData.length === 0) return "";

  const hasAudio = attachments.some(a => a.type === "audio" || a.type === "voice");
  const hasImage = attachments.some(a => a.type === "image" || a.type === "photo");
  const hasVideo = attachments.some(a => a.type === "video");
  const hasDoc = attachments.some(a => a.type === "document");

  let analysisPrompt = caption || "";
  if (!analysisPrompt) {
    if (hasAudio) analysisPrompt = `Transcribe this audio and respond naturally in ${rule.language}. If it's a question, answer it.`;
    else if (hasImage) analysisPrompt = `Describe this image briefly and respond to it naturally in ${rule.language}.`;
    else if (hasVideo) analysisPrompt = `Describe what happens in this video and respond naturally in ${rule.language}.`;
    else if (hasDoc) analysisPrompt = `Read this document and summarize the key information in ${rule.language}.`;
  }

  const systemPrompt = buildSystemPrompt(rule, brainContext);
  const omniContent = buildOmniContent(analysisPrompt, attachments, mediaData);

  console.log(`[omni] Analyzing ${attachments.length} attachment(s): ${attachments.map(a => a.type).join(", ")}`);

  const response = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_OMNI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: omniContent },
      ],
      max_tokens: LLM_OMNI_MAX_TOKENS,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[omni] LLM error ${response.status}: ${text}`);
    return "";
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  let reply = data.choices[0]?.message?.content?.trim() || "";
  reply = reply.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FA9F}\u{1FAA0}-\u{1FAFF}]/gu, "").trim();
  reply = reply.replace(/^¡+/, "").trim();
  console.log(`[omni] Reply: "${reply.substring(0, 100)}..."`);
  return reply;
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

async function generateReply(
  rule: Rule, history: DbMessage[], incomingMessage: string, senderId: string, brainContext: string, bufferedContext: string = ""
): Promise<string> {
  const conversationHistory = history.map((msg) => ({
    role: msg.direction === "inbound" ? "user" : "assistant",
    content: msg.content,
  }));

  if (bufferedContext) {
    conversationHistory.push({
      role: "user",
      content: `[Contexto previo no respondido]\n${bufferedContext}`,
    });
  }

  conversationHistory.push({ role: "user", content: incomingMessage });

  const messages = [
    { role: "system", content: buildSystemPrompt(rule, brainContext) },
    ...conversationHistory,
  ];

  const response = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: 120, temperature: 0.9 }),
  });

  if (!response.ok) { const text = await response.text(); throw new Error(`LLM ${response.status}: ${text}`); }
  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  let reply = data.choices[0]?.message?.content?.trim() || "...";
  // Strip emojis from reply text
  reply = reply.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FA9F}\u{1FAA0}-\u{1FAFF}]/gu, "").trim();
  // Strip leading exclamation marks
  reply = reply.replace(/^¡+/, "").trim();
  return reply;
}

// ─── Message Handler ─────────────────────────────────────────────────────────

async function handleMessage(msg: NormalizedMessage): Promise<void> {
  const { platform, conversationId, content, senderId, messageId, attachments } = msg;
  const hasMedia = attachments && attachments.length > 0;
  const contentPreview = content ? content.substring(0, 60) : (hasMedia ? `[${attachments!.map(a => a.type).join("+")}]` : "");
  console.log(`[${platform}] Message from ${conversationId} (${msg.senderName || senderId}): "${contentPreview}..."`);

  const rule = config.rules.find((r) =>
    r.conversation_id === conversationId && r.enabled && r.platform === platform
  );
  if (!rule) return;

  const currentCount = replyCounters.get(conversationId) || 0;
  if (rule.max_replies > 0 && currentCount >= rule.max_replies) {
    console.log(`[worker] Max replies reached for ${rule.name}`);
    return;
  }

  console.log(`[worker] Rule "${rule.name}" matched. platform=${platform}, brain=${rule.brain}`);

  // ── Smart classification ──
  let classification: ClassificationResult = { should_reply: true, reaction: null };

  if (rule.smart_reply || rule.emoji_reactions) {
    const recentCtx = contextBuffers.get(conversationId)
      ?.messages.slice(-3).map(m => m.content).join("\n") || "";
    classification = await classifyMessage(content, recentCtx);
    console.log(`[classify] should_reply=${classification.should_reply}, reaction=${classification.reaction}`);
  }

  // ── Send reaction (independent of reply decision) ──
  if (rule.emoji_reactions && classification.reaction && messageId) {
    try {
      if (platform === "whatsapp") {
        await sendWhatsAppReaction(conversationId, messageId, classification.reaction);
      } else {
        await sendTelegramReaction(conversationId, messageId, classification.reaction);
      }
    } catch (err) {
      console.warn(`[react] Failed:`, err);
    }
  }

  // ── Reply decision ──
  if (rule.smart_reply && !classification.should_reply) {
    addToBuffer(conversationId, content, senderId);
    console.log(`[worker] Buffered message from ${rule.name} (no reply needed, buffer=${contextBuffers.get(conversationId)?.messages.length || 0} msgs)`);
    return;
  }

  // ── Generate and send reply ──
  const bufferedContext = consumeBuffer(conversationId);
  if (bufferedContext) console.log(`[worker] Injecting buffered context (${bufferedContext.length} chars)`);

  const historyPromise = platform === "telegram"
    ? fetchTgRecentMessages(conversationId, 20)
    : fetchWaRecentMessages(conversationId, 20);

  const [history, brainContext] = await Promise.all([
    historyPromise,
    rule.brain !== "none" ? queryBrain(rule.brain, content) : Promise.resolve(""),
  ]);

  await new Promise((resolve) => setTimeout(resolve, REPLY_DELAY_MS));

  try {
    let reply: string;

    if (hasMedia && attachments!.length > 0) {
      // Use Qwen3-Omni for media analysis
      reply = await analyzeMedia(rule, attachments!, content, brainContext);
      if (!reply) reply = await generateReply(rule, history, content || "[media received]", senderId, brainContext, bufferedContext);
    } else {
      reply = await generateReply(rule, history, content, senderId, brainContext, bufferedContext);
    }
    console.log(`[worker] Reply: "${reply.substring(0, 100)}..."`);

    if (platform === "telegram") {
      await sendTelegramReply(conversationId, reply);
    } else {
      await sendWhatsAppReply(conversationId, reply);
    }
    replyCounters.set(conversationId, currentCount + 1);
  } catch (err) {
    console.error(`[worker] Error:`, err);
  }
}

// ─── Webhook Server ──────────────────────────────────────────────────────────

function startWebhookServer(): void {
  const app = express();
  app.use(express.json({ verify: (req: any, res, buf) => { req.rawBody = buf.toString(); } }));

  app.post("/telegram-webhook", (req, res) => {
    const timestamp = req.headers["x-bridge-timestamp"] as string;
    const signature = req.headers["x-bridge-signature"] as string;
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    if (!verifyBridgeWebhook(timestamp, signature, rawBody)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const data = req.body;
    const msg: NormalizedMessage = {
      platform: "telegram",
      conversationId: data.conversationId,
      senderId: data.senderId,
      senderName: data.senderName,
      content: data.content || "",
      messageId: data.telegramMessageId,
      messageType: data.messageType,
      attachments: data.attachments?.map((a: any) => ({
        type: a.type,
        fileId: a.fileId,
        mimeType: a.mimeType,
        fileName: a.fileName,
      })),
    };

    handleMessage(msg).catch((err) => console.error("[webhook] Error:", err));
    res.json({ ok: true });
  });

  app.get("/health", (req, res) => {
    res.json({ status: "ok", rules: config.rules.length });
  });

  app.listen(WEBHOOK_PORT, () => {
    console.log(`[webhook] Listening on port ${WEBHOOK_PORT}`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[auto-reply-worker] Starting...");

  config = loadConfig();
  console.log(`[config] Loaded ${config.rules.length} rules`);
  config.rules.forEach((r) => {
    const docs = [r.soul && "SOUL", r.identity && "IDENTITY", r.user && "USER", r.memory && "MEMORY", r.tools && "TOOLS", r.agents && "AGENTS"].filter(Boolean);
    console.log(`  - ${r.name} (${r.conversation_id}): platform=${r.platform}, enabled=${r.enabled}, brain=${r.brain}, smart=${r.smart_reply}, reactions=${r.emoji_reactions}, docs=[${docs.join(",")}]`);
  });

  try { await waPool.query("SELECT 1"); console.log("[db:wa] Postgres OK"); } catch (err) { console.error("[db:wa] Postgres failed:", err); }

  if (TG_BRIDGE_URL) console.log(`[tg] Bridge URL: ${TG_BRIDGE_URL}`);

  startWebhookServer();

  console.log(`[nats] Connecting to ${NATS_URL}...`);
  let caCert: Buffer | undefined;
  try { caCert = readFileSync(NATS_CA_CERT); } catch { /* no cert */ }

  const nc: NatsConnection = await connect({
    servers: NATS_URL,
    tls: caCert ? { caFile: NATS_CA_CERT } : undefined,
    reconnect: true, maxReconnectAttempts: -1, reconnectTimeWait: 3000,
  });
  console.log(`[nats] Connected to ${nc.getServer()}`);

  const jc = JSONCodec();
  const waSub: Subscription = nc.subscribe("whatsapp.MessageReceived");
  console.log(`[nats] Subscribed to whatsapp.MessageReceived`);

  for await (const msg of waSub) {
    try {
      const event = jc.decode(msg.data) as any;
      if (event.eventType !== "MESSAGE_RECEIVED" && event.eventType !== "MessageReceived") continue;
      const isMedia = ["IMAGE", "AUDIO", "VIDEO", "DOCUMENT", "VOICE"].includes(event.messageType);
      if (event.messageType !== "TEXT" && !isMedia) continue;
      await handleMessage({
        platform: "whatsapp",
        conversationId: event.conversationId,
        senderId: event.senderWaId,
        content: event.content || "",
        messageId: event.waMessageId,
        messageType: event.messageType,
        attachments: event.attachments?.map((a: any) => ({
          type: event.messageType?.toLowerCase() || a.type,
          url: a.url,
          mimeType: a.metadata?.mimetype || a.metadata?.mimeType,
          fileName: a.metadata?.fileName,
        })),
      });
    } catch (err) { console.error("[worker] WA NATS error:", err); }
  }
  await nc.drain();
}

process.on("SIGTERM", async () => { await waPool.end(); process.exit(0); });
process.on("SIGINT", async () => { await waPool.end(); process.exit(0); });
main().catch((err) => { console.error("[auto-reply-worker] Fatal:", err); process.exit(1); });
