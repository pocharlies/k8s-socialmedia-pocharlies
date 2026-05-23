/**
 * WhatsApp Cloud API Client
 * Uses Meta Graph API to send messages via the official WhatsApp Business Platform.
 */

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

export interface CloudAPIConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
}

export interface SendMessageResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

export class WhatsAppCloudAPI {
  private config: CloudAPIConfig;

  constructor(config: CloudAPIConfig) {
    this.config = config;
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${GRAPH_API_BASE}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (method === 'POST' && body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WhatsApp Cloud API error (${response.status}): ${error}`);
    }
    return response.json() as Promise<T>;
  }

  async sendText(to: string, text: string): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      }
    );
  }

  async sendTemplate(
    to: string,
    templateName: string,
    languageCode = 'es'
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      }
    );
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, ...(caption && { caption }) },
      }
    );
  }

  async sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { link: documentUrl, filename, ...(caption && { caption }) },
      }
    );
  }

  async sendReaction(to: string, messageId: string, emoji: string): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        to,
        type: 'reaction',
        reaction: { message_id: messageId, emoji },
      }
    );
  }

  /** Upload binary media to WhatsApp; returns the media id used to send it. */
  async uploadMedia(data: Buffer, mimeType: string, filename = 'audio.ogg'): Promise<string> {
    const url = `${GRAPH_API_BASE}/${this.config.phoneNumberId}/media`;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([data], { type: mimeType }), filename);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      body: form,
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WhatsApp media upload error (${response.status}): ${error}`);
    }
    const json = (await response.json()) as { id: string };
    return json.id;
  }

  /** Send an audio message by media id. Ogg/Opus renders as a voice note (PTT). */
  async sendAudio(to: string, mediaId: string): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: { id: mediaId },
      }
    );
  }

  async markAsRead(messageId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }
    );
  }

  async getPhoneNumberInfo(): Promise<{
    verified_name: string;
    display_phone_number: string;
    id: string;
    quality_rating: string;
  }> {
    return this.request(
      `/${this.config.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`
    );
  }

  async getBusinessProfile(): Promise<unknown> {
    return this.request(
      `/${this.config.phoneNumberId}/whatsapp_business_profile?fields=about,address,description,vertical,websites`
    );
  }
}
