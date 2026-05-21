import { readFileSync } from 'fs';
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

    const migrationPath = join(__dirname, 'migrations', '001_initial_schema.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    console.log('Running migration...');
    await client.query(sql);
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
