/**
 * Redacts PII (Personally Identifiable Information) from log messages
 */

const PHONE_PATTERN = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const WHATSAPP_ID_PATTERN = /\d+@[s|c]\.whatsapp\.net/g;

/**
 * Redacts phone numbers from text
 */
export function redactPhoneNumbers(text: string): string {
  return text.replace(PHONE_PATTERN, '[REDACTED_PHONE]');
}

/**
 * Redacts email addresses from text
 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

/**
 * Redacts WhatsApp IDs from text
 */
export function redactWhatsAppIds(text: string): string {
  return text.replace(WHATSAPP_ID_PATTERN, '[REDACTED_WA_ID]');
}

/**
 * Redacts message content (optional, based on configuration)
 */
export function redactMessageContent(content: string | null): string | null {
  if (!content) return content;
  // For now, we'll redact phone numbers and WhatsApp IDs
  // Message body redaction can be toggled via config
  return redactWhatsAppIds(redactPhoneNumbers(content));
}

/**
 * Comprehensive PII redaction
 */
export function redactPII(
  text: string,
  options?: {
    redactPhones?: boolean;
    redactEmails?: boolean;
    redactWhatsAppIds?: boolean;
    redactMessageContent?: boolean;
  }
): string {
  const {
    redactPhones: shouldRedactPhones = true,
    redactEmails: shouldRedactEmails = true,
    redactWhatsAppIds: shouldRedactWhatsAppIds = true,
    redactMessageContent: shouldRedactMessageContent = false,
  } = options || {};

  let result = text;

  if (shouldRedactPhones) {
    result = redactPhoneNumbers(result);
  }

  if (shouldRedactEmails) {
    result = redactEmails(result);
  }

  if (shouldRedactWhatsAppIds) {
    result = redactWhatsAppIds(result);
  }

  if (shouldRedactMessageContent) {
    result = redactMessageContent(result) || result;
  }

  return result;
}
