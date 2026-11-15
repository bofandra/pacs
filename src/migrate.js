import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
const pool = new pg.Pool({ connectionString: config().databaseUrl });
try {
  await pool.query(await readFile(new URL('../db/001_init.sql', import.meta.url), 'utf8'));
  console.log('PACS schema migrated');
} finally {
  await pool.end();
}
