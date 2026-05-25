import { accountKey, stripAccount, normalizeAccount, ACCOUNTS } from './account';

describe('account helpers', () => {
  it('keeps personal ids bare (no backfill of existing rows)', () => {
    expect(accountKey('personal', '34660242739@s.whatsapp.net')).toBe('34660242739@s.whatsapp.net');
    expect(accountKey('personal', 'tg_123')).toBe('tg_123');
  });

  it('namespaces professional ids', () => {
    expect(accountKey('professional', 'tg_123')).toBe('professional:tg_123');
    expect(accountKey('professional', '3EB0ABC')).toBe('professional:3EB0ABC');
  });

  it('does NOT collide across accounts for the same raw id', () => {
    expect(accountKey('personal', 'x')).not.toBe(accountKey('professional', 'x'));
  });

  it('accountKey is idempotent (never double-prefixes an already-namespaced id)', () => {
    expect(accountKey('professional', 'professional:tg_123')).toBe('professional:tg_123');
    expect(accountKey('professional', accountKey('professional', 'tg_123'))).toBe('professional:tg_123');
    expect(accountKey('personal', 'tg_123')).toBe('tg_123');
  });

  it('round-trips accountKey <-> stripAccount for every account', () => {
    for (const a of ACCOUNTS) {
      const raw = 'tg_999_42';
      expect(stripAccount(accountKey(a, raw))).toEqual({ account: a, id: raw });
    }
  });

  it('treats an un-prefixed key as personal', () => {
    expect(stripAccount('34660242739@s.whatsapp.net')).toEqual({
      account: 'personal',
      id: '34660242739@s.whatsapp.net',
    });
  });

  it('normalizeAccount defaults to personal and validates', () => {
    expect(normalizeAccount(undefined)).toBe('personal');
    expect(normalizeAccount('personal')).toBe('personal');
    expect(normalizeAccount('professional')).toBe('professional');
    expect(normalizeAccount('garbage')).toBe('personal');
    expect(normalizeAccount(null)).toBe('personal');
  });
});
