import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './db';
import { loadEnvFile } from '../config/env';

/** Aplica as migrações versionadas em drizzle/. Uso: npm run db:migrate [-- --test] */
export async function runMigrations(url: string): Promise<void> {
  const pool = createPool(url);
  try {
    await migrate(createDb(pool), { migrationsFolder: resolve(__dirname, '../../drizzle') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  loadEnvFile();
  const useTest = process.argv.includes('--test');
  const url = useTest ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
  if (!url) {
    console.error(`Defina ${useTest ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} no .env.`);
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log(`Migrações aplicadas (${useTest ? 'teste' : 'desenvolvimento'}).`))
    .catch((err) => {
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      console.error('Falha ao aplicar migrações:', err instanceof Error ? err.message + cause : err);
      process.exit(1);
    });
}
