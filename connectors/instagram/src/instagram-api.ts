/**
 * Instagram Graph API Client
 * Adapted from MCP-instagram standalone server.
 * Handles all communication with Meta's Graph API for Instagram Business accounts.
 */

const GRAPH_API_BASE = "https://graph.instagram.com/v21.0";
const FB_GRAPH_API_BASE = "https://graph.facebook.com/v22.0";

export interface InstagramConfig {
  accessToken: string;
  businessAccountId: string;
  appId?: string;
  appSecret?: string;
  /**
   * Optional Facebook (EAA) access token. Required for endpoints that only
   * exist on graph.facebook.com — hashtag search/media, /me/accounts and
   * business_discovery — when the primary `accessToken` is an Instagram
   * Login (IGAA) token.
   */
  fbAccessToken?: string;
  /**
   * Instagram User ID (e.g. 17841444094675941) — distinct from
   * `businessAccountId` which is the legacy Facebook Graph IG account ID.
   * Required for graph.facebook.com hashtag/business_discovery endpoints.
   * Populated by main.ts after a /me lookup against the IGAA token.
   */
  instagramUserId?: string;
}

export interface MediaItem {
  id: string;
  caption: string;
  media_type: string;
  media_url: string;
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

export interface Conversation {
  id: string;
  participants: { data: Array<{ id: string; username: string }> };
  messages: { data: Array<{ id: string; message: string; from: { id: string; username: string }; created_time: string }> };
  updated_time: string;
}

export class InstagramAPI {
  private config: InstagramConfig;

  constructor(config: InstagramConfig) {
    this.config = config;
  }

  /** Update the IG User ID after construction (main.ts learns it from /me). */
  setInstagramUserId(id: string): void {
    this.config.instagramUserId = id;
  }

  /** ID to pass to graph.facebook.com endpoints — IG User ID if known, else fallback. */
  private fbUserId(): string {
    return this.config.instagramUserId || this.config.businessAccountId;
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, string> = {},
    method: "GET" | "POST" = "GET",
    body?: Record<string, string>
  ): Promise<T> {
    const url = new URL(`${GRAPH_API_BASE}${endpoint}`);
    url.searchParams.set("access_token", this.config.accessToken);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const options: RequestInit = { method };
    if (method === "POST" && body) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Instagram API error (${response.status}): ${error}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Hit graph.facebook.com with the EAA token. Used for the four endpoints
   * that don't exist on graph.instagram.com (hashtag search/media,
   * /me/accounts, business_discovery).
   */
  private async fbRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    method: "GET" | "POST" = "GET",
    body?: Record<string, string>
  ): Promise<T> {
    if (!this.config.fbAccessToken) {
      throw new Error(
        "This endpoint requires a Facebook Login (EAA) access token. " +
        "Set INSTAGRAM_<ACCOUNT>_FB_ACCESS_TOKEN in the connector .env."
      );
    }
    const url = new URL(`${FB_GRAPH_API_BASE}${endpoint}`);
    url.searchParams.set("access_token", this.config.fbAccessToken);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const options: RequestInit = { method };
    if (method === "POST" && body) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url.toString(), options);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Facebook API error (${response.status}): ${error}`);
    }
    return response.json() as Promise<T>;
  }

  async getProfile() {
    return this.request<{
      id: string; name: string; username: string; biography: string;
      followers_count: number; follows_count: number; media_count: number;
    }>(
      `/${this.config.businessAccountId}`,
      { fields: "id,name,username,biography,followers_count,follows_count,media_count,profile_picture_url,website" }
    );
  }

  async getRecentMedia(limit = 25) {
    return this.request<{ data: MediaItem[] }>(
      `/${this.config.businessAccountId}/media`,
      { fields: "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count", limit: String(limit) }
    );
  }

  async getMediaComments(mediaId: string, limit = 50) {
    return this.request<{ data: Array<{ id: string; text: string; username: string; timestamp: string }> }>(
      `/${mediaId}/comments`,
      { fields: "id,text,username,timestamp", limit: String(limit) }
    );
  }

  async replyToComment(commentId: string, message: string) {
    return this.request<{ id: string }>(
      `/${commentId}/replies`,
      {},
      "POST",
      { message }
    );
  }

  async getConversations(limit = 20) {
    return this.request<{ data: Conversation[] }>(
      `/${this.config.businessAccountId}/conversations`,
      {
        fields: "id,participants,messages{id,message,from,created_time},updated_time",
        platform: "instagram",
        limit: String(limit),
      }
    );
  }

  async sendMessage(recipientId: string, messageText: string) {
    return this.request<{ recipient_id: string; message_id: string }>(
      `/${this.config.businessAccountId}/messages`,
      {},
      "POST",
      {
        recipient: JSON.stringify({ id: recipientId }),
        message: JSON.stringify({ text: messageText }),
      }
    );
  }

  async getMediaInsights(mediaId: string) {
    const result = await this.request<{ data: Array<{ name: string; values: Array<{ value: number }> }> }>(
      `/${mediaId}/insights`,
      { metric: "impressions,reach,engagement,saved" }
    );
    const metrics: Record<string, number> = {};
    for (const item of result.data) {
      metrics[item.name] = item.values[0]?.value ?? 0;
    }
    return { id: mediaId, metrics };
  }

  async createMediaContainer(imageUrl: string, caption: string, mediaType: "IMAGE" | "VIDEO" = "IMAGE") {
    const params: Record<string, string> = { caption };
    if (mediaType === "IMAGE") {
      params.image_url = imageUrl;
    } else if (mediaType === "VIDEO") {
      params.video_url = imageUrl;
      params.media_type = "REELS";
    }
    return this.request<{ id: string }>(
      `/${this.config.businessAccountId}/media`,
      params,
      "POST"
    );
  }

  async publishMedia(containerId: string) {
    return this.request<{ id: string }>(
      `/${this.config.businessAccountId}/media_publish`,
      { creation_id: containerId },
      "POST"
    );
  }

  async getStories() {
    return this.request<{ data: MediaItem[] }>(
      `/${this.config.businessAccountId}/stories`,
      { fields: "id,caption,media_type,media_url,permalink,timestamp" }
    );
  }

  async searchHashtag(hashtag: string) {
    return this.fbRequest<{ data: Array<{ id: string }> }>(
      `/ig_hashtag_search`,
      { q: hashtag.replace(/^#/, ""), user_id: this.fbUserId() }
    );
  }

  async refreshToken() {
    if (!this.config.appSecret) throw new Error("App secret required for token refresh");
    return this.request<{ access_token: string; token_type: string; expires_in: number }>(
      `/oauth/access_token`,
      {
        grant_type: "fb_exchange_token",
        client_id: this.config.appId ?? "",
        client_secret: this.config.appSecret,
        fb_exchange_token: this.config.accessToken,
      }
    );
  }

  // ── Publishing: carousel / reel / story ────────────────────────────────

  async publishCarousel(items: string[], caption?: string) {
    if (items.length < 2) throw new Error("Carousel requires at least 2 items");
    if (items.length > 10) throw new Error("Carousel supports maximum 10 items");
    const childIds: string[] = [];
    for (const url of items) {
      const isVideo = /\.(mp4|mov)$/i.test(url);
      const body: Record<string, string> = { is_carousel_item: "true" };
      if (isVideo) {
        body.video_url = url;
        body.media_type = "VIDEO";
      } else {
        body.image_url = url;
      }
      const child = await this.request<{ id: string }>(`/${this.config.businessAccountId}/media`, {}, "POST", body);
      childIds.push(child.id);
    }
    const carouselBody: Record<string, string> = { media_type: "CAROUSEL", children: childIds.join(",") };
    if (caption) carouselBody.caption = caption;
    const carousel = await this.request<{ id: string }>(`/${this.config.businessAccountId}/media`, {}, "POST", carouselBody);
    const published = await this.publishMedia(carousel.id);
    return { container_id: carousel.id, media_id: published.id, child_container_ids: childIds };
  }

  async publishReel(videoUrl: string, caption?: string, shareToFeed = true) {
    const body: Record<string, string> = {
      media_type: "REELS",
      video_url: videoUrl,
      share_to_feed: String(shareToFeed),
    };
    if (caption) body.caption = caption;
    const container = await this.request<{ id: string }>(`/${this.config.businessAccountId}/media`, {}, "POST", body);
    const published = await this.publishMedia(container.id);
    return { container_id: container.id, media_id: published.id };
  }

  async publishStory(opts: { imageUrl?: string; videoUrl?: string }) {
    const body: Record<string, string> = { media_type: "STORIES" };
    if (opts.imageUrl) body.image_url = opts.imageUrl;
    else if (opts.videoUrl) body.video_url = opts.videoUrl;
    else throw new Error("Either imageUrl or videoUrl is required");
    const container = await this.request<{ id: string }>(`/${this.config.businessAccountId}/media`, {}, "POST", body);
    const published = await this.publishMedia(container.id);
    return { container_id: container.id, media_id: published.id };
  }

  // ── Comments: post / hide / delete ────────────────────────────────────

  async postComment(mediaId: string, message: string) {
    const data = await this.request<{ id: string }>(`/${mediaId}/comments`, {}, "POST", { message });
    return { id: data.id, text: message };
  }

  async hideComment(commentId: string, hide = true) {
    await this.request<unknown>(`/${commentId}`, {}, "POST", { hide: String(hide) });
    return { id: commentId, hidden: hide };
  }

  async deleteComment(commentId: string) {
    const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
    url.searchParams.set("access_token", this.config.accessToken);
    const response = await fetch(url.toString(), { method: "DELETE" });
    if (!response.ok) {
      throw new Error(`Instagram API error (${response.status}): ${await response.text()}`);
    }
    return { id: commentId, deleted: true };
  }

  // ── Account: insights / pages / publishing limit / token validation ──

  async getAccountInsights(metrics?: string[], period: "day" | "week" | "days_28" = "day") {
    const m = metrics && metrics.length ? metrics : ["reach", "profile_views", "website_clicks"];
    return this.request<{ data: Array<{ name: string; period: string; values: Array<{ value: number }>; total_value?: { value: number } }> }>(
      `/${this.config.businessAccountId}/insights`,
      { metric: m.join(","), period, metric_type: "total_value" }
    );
  }

  async getAccountPages() {
    return this.fbRequest<{ data: Array<{ id: string; name: string; instagram_business_account?: { id: string } }> }>(
      `/me/accounts`,
      { fields: "id,name,instagram_business_account" }
    );
  }

  async getContentPublishingLimit() {
    const data = await this.request<{ data: Array<{ quota_usage?: number; config?: { quota_total: number; quota_duration: number } }> }>(
      `/${this.config.businessAccountId}/content_publishing_limit`,
      { fields: "quota_usage,config,quota_duration" }
    );
    return data.data?.[0] ?? {};
  }

  async validateAccessToken(): Promise<boolean> {
    try {
      await this.request<{ id: string }>(`/me`, { fields: "id" });
      return true;
    } catch {
      return false;
    }
  }

  // ── Hashtags: search + media ──────────────────────────────────────────

  async getHashtagMedia(hashtagId: string, mediaType: "top" | "recent" = "top", limit = 25) {
    return this.fbRequest<{ data: Array<{ id: string; media_type: string; media_url?: string; permalink: string; caption?: string; timestamp: string; like_count?: number; comments_count?: number }> }>(
      `/${hashtagId}/${mediaType}_media`,
      {
        user_id: this.fbUserId(),
        fields: "id,media_type,media_url,permalink,caption,timestamp,like_count,comments_count",
        limit: String(Math.min(limit, 50)),
      }
    );
  }

  // ── Mentions ──────────────────────────────────────────────────────────

  async getMentions(limit = 25) {
    return this.request<{ data: Array<{ id: string; media_type: string; media_url?: string; permalink: string; caption?: string; timestamp: string; username?: string }> }>(
      `/${this.config.businessAccountId}/tags`,
      {
        fields: "id,media_type,media_url,permalink,caption,timestamp,username",
        limit: String(Math.min(limit, 100)),
      }
    );
  }

  // ── Business Discovery ────────────────────────────────────────────────

  async businessDiscovery(targetUsername: string) {
    const fields = "username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url";
    const data = await this.fbRequest<{ business_discovery?: Record<string, unknown> }>(
      `/${this.fbUserId()}`,
      { fields: `business_discovery.username(${targetUsername}){${fields}}` }
    );
    if (!data.business_discovery) throw new Error(`Could not find business account: ${targetUsername}`);
    return data.business_discovery;
  }

  // ── Conversation messages ─────────────────────────────────────────────

  async getConversationMessages(conversationId: string, limit = 25) {
    const fields = "id,from,to,message,created_time,attachments";
    const data = await this.request<{ messages?: { data: Array<Record<string, unknown>> } }>(
      `/${conversationId}`,
      { fields: `messages{${fields}}`, limit: String(Math.min(limit, 100)) }
    );
    return { data: data.messages?.data ?? [] };
  }
}
