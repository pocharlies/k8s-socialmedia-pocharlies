/**
 * Multi-account (personal / professional) helpers.
 *
 * DB scoping strategy (migration 002): a row's id is namespaced by account so
 * the existing PK/UNIQUE constraints stay globally valid across accounts.
 * "personal" keeps the bare id (so the ~449k pre-existing single-account rows
 * need NO backfill); "professional" is prefixed with "professional:".
 * The `account` column is a denormalized, indexed copy for fast read filtering.
 */
export type Account = 'personal' | 'professional';

export const ACCOUNTS: readonly Account[] = ['personal', 'professional'] as const;

/** Validate/normalize an account selector coming from a tool arg. Defaults to 'personal'. */
export function normalizeAccount(value: unknown): Account {
  return value === 'professional' ? 'professional' : 'personal';
}

/** Namespace an id by account. Personal stays bare; others are prefixed. */
export function accountKey(account: Account, id: string): string {
  return account === 'personal' ? id : `${account}:${id}`;
}

/** Inverse of accountKey: recover { account, id } from a (possibly namespaced) key. */
export function stripAccount(key: string): { account: Account; id: string } {
  for (const a of ACCOUNTS) {
    if (a !== 'personal' && key.startsWith(`${a}:`)) {
      return { account: a, id: key.slice(a.length + 1) };
    }
  }
  return { account: 'personal', id: key };
}
