import { Conversation, ConversationType } from './conversation.entity';

describe('Conversation Entity', () => {
  it('should create a new conversation', () => {
    const conversation = Conversation.create(
      '1234567890@s.whatsapp.net',
      ConversationType.INDIVIDUAL,
      'Test User'
    );

    expect(conversation.waChatId).toBe('1234567890@s.whatsapp.net');
    expect(conversation.type).toBe(ConversationType.INDIVIDUAL);
    expect(conversation.name).toBe('Test User');
    expect(conversation.id).toBeDefined();
    expect(conversation.createdAt).toBeInstanceOf(Date);
  });

  it('should update last message timestamp', () => {
    const conversation = Conversation.create(
      '1234567890@s.whatsapp.net',
      ConversationType.INDIVIDUAL
    );

    const timestamp = new Date();
    conversation.updateLastMessageAt(timestamp);

    expect(conversation.lastMessageAt).toEqual(timestamp);
    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      conversation.createdAt.getTime()
    );
  });

  it('should update metadata', () => {
    const conversation = Conversation.create(
      '1234567890@s.whatsapp.net',
      ConversationType.INDIVIDUAL
    );

    conversation.updateMetadata({ customField: 'value' });

    expect(conversation.metadata).toEqual({ customField: 'value' });
  });
});
