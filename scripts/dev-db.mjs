// Sobe um PostgreSQL 18 real (binários oficiais via `embedded-postgres`) para
// desenvolvimento e testes em máquinas sem Docker. Os dados ficam em
// .data/postgres e persistem entre execuções. Escuta somente em 127.0.0.1.
//
// Uso: npm run db:start   (Ctrl+C para parar)
//
// Em ambientes com Docker, prefira `docker compose up postgres redis`.
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if ((process.env.APP_ENV ?? 'development') === 'production') {
  console.error('dev-db: recusado. Este banco embarcado é apenas para desenvolvimento e testes.');
  process.exit(1);
}

const password = process.env.DEV_DB_PASSWORD;
if (!password) {
  console.error('dev-db: defina DEV_DB_PASSWORD no arquivo .env (veja .env.example).');
  process.exit(1);
}

const port = Number(process.env.DEV_DB_PORT ?? 5433);
const dataDir = resolve(root, '.data/postgres');
mkdirSync(resolve(root, '.data'), { recursive: true });
const firstRun = !existsSync(resolve(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'oralis',
  password,
  port,
  persistent: true,
  onLog: () => {},
  onError: (message) => console.error(String(message).trim()),
});

if (firstRun) await pg.initialise();
await pg.start();

for (const db of ['oralis_dev', 'oralis_test']) {
  try {
    await pg.createDatabase(db);
    console.log(`dev-db: banco ${db} criado.`);
  } catch {
    // já existe
  }
}

console.log(`dev-db: PostgreSQL pronto em 127.0.0.1:${port} (bancos oralis_dev e oralis_test). Ctrl+C para parar.`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\ndev-db: encerrando...');
  await pg.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
