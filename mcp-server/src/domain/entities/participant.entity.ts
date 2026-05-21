export class Participant {
  constructor(
    public id: string,
    public conversationId: string,
    public waUserId: string,
    public name: string | null,
    public isAdmin: boolean,
    public joinedAt: Date,
    public leftAt: Date | null
  ) {}

  static create(
    conversationId: string,
    waUserId: string,
    name: string | null = null,
    isAdmin: boolean = false
  ): Participant {
    return new Participant(
      crypto.randomUUID(),
      conversationId,
      waUserId,
      name,
      isAdmin,
      new Date(),
      null
    );
  }

  markAsLeft(): void {
    this.leftAt = new Date();
  }

  updateName(name: string): void {
    this.name = name;
  }
}
