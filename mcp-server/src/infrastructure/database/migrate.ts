import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

async function migrate() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp',
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Run every *.sql in migrations/ in lexical order. All migrations are
    // idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so
    // re-running on an already-migrated DB is a no-op.
    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf-8');
      console.log(`Running migration ${file}...`);
      await client.query(sql);
    }
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
