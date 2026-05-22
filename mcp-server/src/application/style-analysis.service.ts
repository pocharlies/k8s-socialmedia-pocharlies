import { Pool } from 'pg';
import Redis from 'ioredis';
import { decryptString } from '@mcp-socialmedia/shared';
import { LlamaService } from './llama.service';
import pino from 'pino';

export interface StyleProfile {
  userId: string;
  platform: 'whatsapp' | 'telegram' | 'combined';
  analyzedAt: Date;
  messageCount: number;

  // Communication patterns
  averageMessageLength: number;
  averageResponseTime: number; // in seconds
  activeHours: number[]; // 0-23
  preferredDays: number[]; // 0-6 (Sunday-Saturday)

  // Language patterns
  primaryLanguage: string;
  formality: 'very_informal' | 'informal' | 'neutral' | 'formal' | 'very_formal';
  emojiUsage: 'none' | 'rare' | 'moderate' | 'frequent' | 'heavy';
  commonEmojis: string[];

  // Writing style
  punctuationStyle: 'minimal' | 'standard' | 'heavy';
  capitalization: 'lowercase' | 'standard' | 'uppercase_heavy';
  abbreviations: string[]; // Common abbreviations used
  commonPhrases: string[]; // Frequent phrases
  greetings: string[]; // How user starts conversations
  farewells: string[]; // How user ends conversations

  // Personality traits (inferred)
  communicationStyle: 'direct' | 'elaborate' | 'emotional' | 'factual';
  humorUsage: 'none' | 'occasional' | 'frequent';
  questionFrequency: 'low' | 'medium' | 'high';

  // Raw data for LLM context
  sampleMessages: string[];
  styleDescription: string;
}

export interface StyleAnalysisOptions {
  platform?: 'whatsapp' | 'telegram' | 'combined';
  messageLimit?: number;
  dateRange?: {
    from?: Date;
    to?: Date;
  };
}

/**
 * Service for analyzing user communication style from WhatsApp and Telegram messages
 * Creates a profile that can be used to generate responses in the user's style
 */
export class StyleAnalysisService {
  private dbClient: Pool;
  private redis: Redis;
  private encryptionKey: Buffer;
  private llamaService: LlamaService;
  private logger: pino.Logger;

  constructor(dbClient: Pool, redisUrl: string, encryptionKey: string, llamaService: LlamaService) {
    this.dbClient = dbClient;
    this.redis = new Redis(redisUrl);
    this.encryptionKey = Buffer.from(encryptionKey, 'utf-8');
    this.llamaService = llamaService;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Analyze user's outbound messages to create a style profile
   */
  async analyzeUserStyle(
    userIdentifier: string,
    options: StyleAnalysisOptions = {}
  ): Promise<StyleProfile> {
    const { platform = 'combined', messageLimit = 5000 } = options;

    this.logger.info(`Analyzing style for user: ${userIdentifier}, platform: ${platform}`);

    // Fetch user's outbound messages
    const messages = await this.fetchUserMessages(userIdentifier, {
      ...options,
      limit: messageLimit,
    });

    if (messages.length < 50) {
      throw new Error('Not enough messages to analyze style (minimum 50 required)');
    }

    this.logger.info(`Analyzing ${messages.length} messages`);

    // Calculate basic statistics
    const stats = this.calculateBasicStats(messages);

    // Analyze language patterns
    const languagePatterns = await this.analyzeLanguagePatterns(messages);

    // Get sample messages for LLM context
    const sampleMessages = this.selectSampleMessages(messages, 100);

    // Use Llama to generate a detailed style description
    const styleDescription = await this.generateStyleDescription(sampleMessages, stats);

    const profile: StyleProfile = {
      userId: userIdentifier,
      platform,
      analyzedAt: new Date(),
      messageCount: messages.length,

      // Basic stats
      averageMessageLength: stats.averageLength,
      averageResponseTime: stats.averageResponseTime,
      activeHours: stats.activeHours,
      preferredDays: stats.preferredDays,

      // Language patterns with defaults
      primaryLanguage: languagePatterns.primaryLanguage ?? 'en',
      formality: languagePatterns.formality ?? 'neutral',
      emojiUsage: languagePatterns.emojiUsage ?? 'moderate',
      commonEmojis: languagePatterns.commonEmojis ?? [],
      punctuationStyle: languagePatterns.punctuationStyle ?? 'standard',
      capitalization: languagePatterns.capitalization ?? 'standard',
      abbreviations: languagePatterns.abbreviations ?? [],
      commonPhrases: languagePatterns.commonPhrases ?? [],
      greetings: languagePatterns.greetings ?? [],
      farewells: languagePatterns.farewells ?? [],
      communicationStyle: languagePatterns.communicationStyle ?? 'direct',
      humorUsage: languagePatterns.humorUsage ?? 'occasional',
      questionFrequency: languagePatterns.questionFrequency ?? 'medium',

      // Samples and description
      sampleMessages,
      styleDescription,
    };

    // Cache the profile
    await this.cacheStyleProfile(profile);

    return profile;
  }

  /**
   * Fetch user's outbound messages from the database
   */
  private async fetchUserMessages(
    userIdentifier: string,
    options: StyleAnalysisOptions & { limit?: number }
  ): Promise<
    Array<{
      content: string;
      timestamp: Date;
      conversationId: string;
      platform: string;
    }>
  > {
    const { dateRange, limit = 5000, platform = 'combined' } = options;

    let sql = `
      SELECT m.content, m.wa_timestamp as timestamp, m.conversation_id,
             c.platform
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.direction = 'OUTBOUND'
        AND m.is_deleted = false
        AND m.content IS NOT NULL
    `;

    const params: unknown[] = [];
    let paramIndex = 1;

    if (platform !== 'combined') {
      sql += ` AND c.platform = $${paramIndex}`;
      params.push(platform);
      paramIndex++;
    }

    if (dateRange?.from) {
      sql += ` AND m.wa_timestamp >= $${paramIndex}`;
      params.push(dateRange.from);
      paramIndex++;
    }

    if (dateRange?.to) {
      sql += ` AND m.wa_timestamp <= $${paramIndex}`;
      params.push(dateRange.to);
      paramIndex++;
    }

    sql += ` ORDER BY m.wa_timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.dbClient.query(sql, params);

    return result.rows
      .map(row => {
        let content = '';
        if (row.content) {
          try {
            content = decryptString(row.content, this.encryptionKey);
          } catch (error) {
            this.logger.warn(`Failed to decrypt message: ${error}`);
          }
        }

        return {
          content,
          timestamp: row.timestamp,
          conversationId: row.conversation_id,
          platform: row.platform || 'whatsapp',
        };
      })
      .filter(m => m.content.length > 0);
  }

  /**
   * Calculate basic statistics from messages
   */
  private calculateBasicStats(messages: Array<{ content: string; timestamp: Date }>) {
    // Average message length
    const totalLength = messages.reduce((sum, m) => sum + m.content.length, 0);
    const averageLength = totalLength / messages.length;

    // Active hours distribution
    const hourCounts = new Array(24).fill(0);
    messages.forEach(m => {
      const hour = m.timestamp.getHours();
      hourCounts[hour]++;
    });

    // Get top 5 active hours
    const activeHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(h => h.hour);

    // Active days distribution
    const dayCounts = new Array(7).fill(0);
    messages.forEach(m => {
      const day = m.timestamp.getDay();
      dayCounts[day]++;
    });

    // Get preferred days
    const preferredDays = dayCounts
      .map((count, day) => ({ day, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(d => d.day);

    // Calculate average response time (simplified - just gaps between consecutive messages)
    let totalGaps = 0;
    let gapCount = 0;
    for (let i = 1; i < messages.length; i++) {
      const gap = messages[i - 1].timestamp.getTime() - messages[i].timestamp.getTime();
      if (gap > 0 && gap < 3600000) {
        // Only count gaps less than 1 hour
        totalGaps += gap;
        gapCount++;
      }
    }
    const averageResponseTime = gapCount > 0 ? totalGaps / gapCount / 1000 : 0;

    return {
      averageLength,
      averageResponseTime,
      activeHours,
      preferredDays,
    };
  }

  /**
   * Analyze language patterns from messages
   */
  private async analyzeLanguagePatterns(
    messages: Array<{ content: string }>
  ): Promise<Partial<StyleProfile>> {
    const allText = messages.map(m => m.content).join(' ');
    const words = allText.toLowerCase().split(/\s+/);
    const totalMessages = messages.length;

    // Detect primary language (simple heuristic)
    const spanishWords = [
      'que',
      'de',
      'la',
      'el',
      'en',
      'es',
      'no',
      'si',
      'para',
      'con',
      'por',
      'un',
      'una',
    ];
    const englishWords = [
      'the',
      'is',
      'are',
      'and',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
    ];

    const spanishCount = words.filter(w => spanishWords.includes(w)).length;
    const englishCount = words.filter(w => englishWords.includes(w)).length;
    const primaryLanguage = spanishCount > englishCount ? 'es' : 'en';

    // Emoji analysis
    const emojiRegex =
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    const allEmojis = allText.match(emojiRegex) || [];
    const emojiFrequency = allEmojis.length / totalMessages;

    let emojiUsage: StyleProfile['emojiUsage'];
    if (emojiFrequency === 0) emojiUsage = 'none';
    else if (emojiFrequency < 0.1) emojiUsage = 'rare';
    else if (emojiFrequency < 0.5) emojiUsage = 'moderate';
    else if (emojiFrequency < 1) emojiUsage = 'frequent';
    else emojiUsage = 'heavy';

    // Get common emojis
    const emojiCounts = new Map<string, number>();
    allEmojis.forEach(emoji => {
      emojiCounts.set(emoji, (emojiCounts.get(emoji) || 0) + 1);
    });
    const commonEmojis = [...emojiCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([emoji]) => emoji);

    // Formality analysis
    const formalIndicators = [
      'usted',
      'estimado',
      'cordialmente',
      'atentamente',
      'please',
      'kindly',
      'dear',
      'sincerely',
    ];
    const informalIndicators = [
      'jaja',
      'haha',
      'lol',
      'xd',
      'jeje',
      'wtf',
      'omg',
      'yay',
      'nah',
      'yeah',
    ];

    const formalCount = words.filter(w => formalIndicators.includes(w)).length;
    const informalCount = words.filter(w => informalIndicators.includes(w)).length;
    const formalityRatio = totalMessages > 0 ? (formalCount - informalCount) / totalMessages : 0;

    let formality: StyleProfile['formality'];
    if (formalityRatio < -0.1) formality = 'very_informal';
    else if (formalityRatio < -0.02) formality = 'informal';
    else if (formalityRatio < 0.02) formality = 'neutral';
    else if (formalityRatio < 0.1) formality = 'formal';
    else formality = 'very_formal';

    // Punctuation analysis
    const punctuationMarks = allText.match(/[.!?,;:]/g) || [];
    const punctuationRatio = punctuationMarks.length / words.length;

    let punctuationStyle: StyleProfile['punctuationStyle'];
    if (punctuationRatio < 0.05) punctuationStyle = 'minimal';
    else if (punctuationRatio < 0.15) punctuationStyle = 'standard';
    else punctuationStyle = 'heavy';

    // Capitalization analysis
    const uppercaseWords = words.filter(w => w === w.toUpperCase() && w.length > 1);
    const uppercaseRatio = uppercaseWords.length / words.length;

    let capitalization: StyleProfile['capitalization'];
    if (uppercaseRatio > 0.1) capitalization = 'uppercase_heavy';
    else if (messages.some(m => m.content === m.content.toLowerCase()))
      capitalization = 'lowercase';
    else capitalization = 'standard';

    // Common phrases (bigrams and trigrams)
    const commonPhrases = this.extractCommonPhrases(messages.map(m => m.content));

    // Greetings and farewells
    const greetingPatterns = [
      'hola',
      'hey',
      'hi',
      'hello',
      'buenos',
      'buenas',
      'que tal',
      'qué tal',
      'como estas',
      'cómo estás',
    ];
    const farewellPatterns = [
      'bye',
      'adios',
      'adiós',
      'chao',
      'ciao',
      'hasta luego',
      'nos vemos',
      'cuídate',
      'cuidate',
    ];

    const greetings = messages
      .map(m => m.content.toLowerCase())
      .filter(c => greetingPatterns.some(g => c.startsWith(g) || c.includes(g)))
      .slice(0, 10);

    const farewells = messages
      .map(m => m.content.toLowerCase())
      .filter(c => farewellPatterns.some(f => c.includes(f)))
      .slice(0, 10);

    // Common abbreviations
    const abbreviationPatterns =
      /\b(q|xq|pq|k|tmb|tb|dnd|xfa|pf|tq|tkm|bn|ml|msj|tel|fds|btw|idk|tbh|imo|fyi|brb|ttyl)\b/gi;
    const abbreviationsFound = allText.match(abbreviationPatterns) || [];
    const abbreviations = [...new Set(abbreviationsFound.map(a => a.toLowerCase()))].slice(0, 15);

    // Communication style inference
    const avgMsgLength = messages.reduce((sum, m) => sum + m.content.length, 0) / messages.length;
    const questionCount = messages.filter(m => m.content.includes('?')).length;
    const emotionalWords = [
      'love',
      'hate',
      'amazing',
      'terrible',
      'excited',
      'sad',
      'happy',
      'angry',
      'amo',
      'odio',
      'increíble',
      'triste',
      'feliz',
    ];
    const emotionalCount = words.filter(w => emotionalWords.includes(w)).length;

    let communicationStyle: StyleProfile['communicationStyle'];
    if (avgMsgLength < 30) communicationStyle = 'direct';
    else if (emotionalCount / totalMessages > 0.1) communicationStyle = 'emotional';
    else if (avgMsgLength > 100) communicationStyle = 'elaborate';
    else communicationStyle = 'factual';

    const questionFrequency: StyleProfile['questionFrequency'] =
      questionCount / totalMessages < 0.1
        ? 'low'
        : questionCount / totalMessages < 0.3
          ? 'medium'
          : 'high';

    const humorIndicators = ['jaja', 'haha', 'lol', '😂', '🤣', 'xd', 'jeje'];
    const humorCount = messages.filter(m =>
      humorIndicators.some(h => m.content.toLowerCase().includes(h))
    ).length;

    const humorUsage: StyleProfile['humorUsage'] =
      humorCount / totalMessages < 0.05
        ? 'none'
        : humorCount / totalMessages < 0.2
          ? 'occasional'
          : 'frequent';

    return {
      primaryLanguage,
      formality,
      emojiUsage,
      commonEmojis,
      punctuationStyle,
      capitalization,
      abbreviations,
      commonPhrases,
      greetings,
      farewells,
      communicationStyle,
      questionFrequency,
      humorUsage,
    };
  }

  /**
   * Extract common phrases from messages
   */
  private extractCommonPhrases(messages: string[]): string[] {
    const phraseCount = new Map<string, number>();

    for (const msg of messages) {
      const words = msg.toLowerCase().split(/\s+/);

      // Extract bigrams and trigrams
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `${words[i]} ${words[i + 1]}`;
        if (bigram.length > 5) {
          phraseCount.set(bigram, (phraseCount.get(bigram) || 0) + 1);
        }

        if (i < words.length - 2) {
          const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
          if (trigram.length > 8) {
            phraseCount.set(trigram, (phraseCount.get(trigram) || 0) + 1);
          }
        }
      }
    }

    // Return phrases that appear at least 3 times
    return [...phraseCount.entries()]
      .filter(([_, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([phrase]) => phrase);
  }

  /**
   * Select diverse sample messages for LLM context
   */
  private selectSampleMessages(
    messages: Array<{ content: string; timestamp: Date }>,
    count: number
  ): string[] {
    // Sort by length to get variety
    const byLength = [...messages].sort((a, b) => a.content.length - b.content.length);

    // Sample from different length buckets
    const samples: string[] = [];
    const bucketSize = Math.floor(messages.length / count);

    for (let i = 0; i < count && i * bucketSize < byLength.length; i++) {
      const msg = byLength[i * bucketSize];
      if (msg.content.length > 5 && msg.content.length < 500) {
        samples.push(msg.content);
      }
    }

    // Add some recent messages
    const recentMessages = messages.slice(0, Math.min(20, messages.length));
    for (const msg of recentMessages) {
      if (samples.length >= count) break;
      if (!samples.includes(msg.content) && msg.content.length > 5) {
        samples.push(msg.content);
      }
    }

    return samples.slice(0, count);
  }

  /**
   * Generate a natural language description of the user's style using Llama
   */
  private async generateStyleDescription(
    sampleMessages: string[],
    stats: { averageLength: number; averageResponseTime: number }
  ): Promise<string> {
    const prompt = `Analiza los siguientes mensajes de un usuario y describe su estilo de comunicación en español.

Mensajes de ejemplo:
${sampleMessages
  .slice(0, 50)
  .map((m, i) => `${i + 1}. "${m}"`)
  .join('\n')}

Información adicional:
- Longitud promedio de mensaje: ${Math.round(stats.averageLength)} caracteres
- Tiempo de respuesta promedio: ${Math.round(stats.averageResponseTime)} segundos

Por favor describe:
1. El tono general (formal/informal)
2. Uso del lenguaje (abreviaciones, emojis, puntuación)
3. Patrones de comunicación
4. Personalidad percibida
5. Características únicas del estilo

Responde en 2-3 párrafos de forma natural.`;

    try {
      const description = await this.llamaService.generateRawCompletion(prompt, {
        temperature: 0.7,
        maxTokens: 500,
      });

      return description;
    } catch (error) {
      this.logger.error(`Error generating style description: ${error}`);
      return 'Style analysis unavailable';
    }
  }

  /**
   * Cache style profile in Redis
   */
  private async cacheStyleProfile(profile: StyleProfile): Promise<void> {
    const cacheKey = `style_profile:${profile.userId}:${profile.platform}`;
    await this.redis.setex(cacheKey, 86400 * 7, JSON.stringify(profile)); // 7 days cache
  }

  /**
   * Get cached style profile
   */
  async getCachedStyleProfile(
    userId: string,
    platform: 'whatsapp' | 'telegram' | 'combined' = 'combined'
  ): Promise<StyleProfile | null> {
    const cacheKey = `style_profile:${userId}:${platform}`;
    const cached = await this.redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached) as StyleProfile;
    }

    return null;
  }

  /**
   * Generate a response in the user's style
   */
  async generateStyledResponse(
    profile: StyleProfile,
    context: string,
    prompt: string
  ): Promise<string> {
    const systemPrompt = `Eres un asistente que debe responder imitando exactamente el estilo de comunicación del usuario.

PERFIL DE ESTILO:
${profile.styleDescription}

CARACTERÍSTICAS CLAVE:
- Idioma principal: ${profile.primaryLanguage === 'es' ? 'Español' : 'Inglés'}
- Formalidad: ${profile.formality}
- Uso de emojis: ${profile.emojiUsage}
- Emojis comunes: ${profile.commonEmojis.join(' ')}
- Abreviaciones comunes: ${profile.abbreviations.join(', ')}
- Frases frecuentes: ${profile.commonPhrases.slice(0, 5).join(', ')}
- Estilo de comunicación: ${profile.communicationStyle}
- Longitud típica: ~${Math.round(profile.averageMessageLength)} caracteres

EJEMPLOS DE MENSAJES DEL USUARIO:
${profile.sampleMessages
  .slice(0, 20)
  .map(m => `"${m}"`)
  .join('\n')}

INSTRUCCIONES:
- Responde EXACTAMENTE como lo haría el usuario
- Mantén el mismo nivel de formalidad, uso de emojis y puntuación
- Usa las mismas abreviaciones y frases que usa el usuario
- Mantén una longitud de mensaje similar
- NO suenes como un asistente de IA, suena natural como el usuario`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      {
        role: 'user' as const,
        content: `Contexto de la conversación:\n${context}\n\nResponde a esto:\n${prompt}`,
      },
    ];

    const response = await this.llamaService.generateCompletion(messages, {
      temperature: 0.8,
      maxTokens: Math.round(profile.averageMessageLength * 2),
    });

    return response;
  }
}
