import pg from 'pg';
import { readFile,readdir } from 'node:fs/promises';
import { config } from './config.js';

const pool = new pg.Pool({ connectionString: config().databaseUrl });
const migrations=(await readdir(new URL('../db/',import.meta.url)))
  .filter(name=>/^\d+_[\w-]+\.sql$/.test(name)).sort();
try {
  const client=await pool.connect();
  try {
    for(const filename of migrations) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('pacs-schema-migrations'))");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations(
          filename TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const seen=await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1',[filename]);
        if(!seen.rowCount) {
          await client.query(await readFile(new URL('../db/'+filename,import.meta.url),'utf8'));
          await client.query('INSERT INTO schema_migrations(filename) VALUES($1)',[filename]);
          console.log('Applied migration',filename);
        }
        await client.query('COMMIT');
      } catch(err) {await client.query('ROLLBACK').catch(()=>{});throw err;}
    }
  } finally {client.release();}
} finally {await pool.end();}
