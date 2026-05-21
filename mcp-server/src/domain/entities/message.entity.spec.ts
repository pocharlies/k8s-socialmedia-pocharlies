import { Message, MessageDirection, MessageType } from './message.entity';

describe('Message Entity', () => {
  it('should create a new message', () => {
    const message = Message.create(
      'conv-123',
      'msg-456',
      new Date(),
      MessageDirection.INBOUND,
      'sender@whatsapp.net',
      'Hello world',
      MessageType.TEXT
    );

    expect(message.conversationId).toBe('conv-123');
    expect(message.waMessageId).toBe('msg-456');
    expect(message.direction).toBe(MessageDirection.INBOUND);
    expect(message.content).toBe('Hello world');
    expect(message.contentHash).toBeDefined();
  });

  it('should mark message as edited', () => {
    const message = Message.create(
      'conv-123',
      'msg-456',
      new Date(),
      MessageDirection.INBOUND,
      'sender@whatsapp.net',
      'Hello',
      MessageType.TEXT
    );

    message.markAsEdited('Hello world');

    expect(message.isEdited).toBe(true);
    expect(message.content).toBe('Hello world');
    expect(message.editedAt).toBeInstanceOf(Date);
  });

  it('should mark message as deleted', () => {
    const message = Message.create(
      'conv-123',
      'msg-456',
      new Date(),
      MessageDirection.INBOUND,
      'sender@whatsapp.net',
      'Hello',
      MessageType.TEXT
    );

    message.markAsDeleted();

    expect(message.isDeleted).toBe(true);
    expect(message.deletedAt).toBeInstanceOf(Date);
  });
});
