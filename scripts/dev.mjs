// Sobe o ambiente de desenvolvimento completo em um só terminal:
// banco (se ainda não estiver rodando) → migrações → API + web.
//
// Uso: npm run dev   (Ctrl+C encerra tudo)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, '.env');
if (!existsSync(envFile)) {
  console.error('dev: arquivo .env não encontrado. Copie .env.example para .env e preencha os valores.');
  process.exit(1);
}
process.loadEnvFile(envFile);

const dbPort = Number(process.env.DEV_DB_PORT ?? 5433);
const COLORS = { db: 35, api: 36, web: 32, migrate: 33 };
const children = [];
let stopping = false;

function run(name, command, { persistent = true } = {}) {
  const child = spawn(command, { cwd: root, shell: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${COLORS[name]}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  if (persistent) {
    children.push(child);
    child.on('exit', (code) => {
      if (stopping) return;
      console.error(`${prefix}encerrou (código ${code}). Encerrando os demais processos.`);
      shutdown(code ?? 1);
    });
  }
  return child;
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}


function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  console.log('\ndev: encerrando...');
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // No Windows, o processo do shell não repassa sinais: encerra a árvore inteira.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (await portOpen(dbPort)) {
  console.log(`dev: PostgreSQL já está rodando na porta ${dbPort}; reutilizando.`);
} else {
  // Espera o próprio dev-db anunciar que está pronto: a porta abre antes do fim
  // da recuperação após um desligamento inesperado.
  const db = run('db', 'node scripts/dev-db.mjs');
  const ready = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 120_000);
    db.stdout.on('data', (chunk) => { if (chunk.toString().includes('PostgreSQL pronto')) { clearTimeout(timer); done(true); } });
    db.on('exit', () => { clearTimeout(timer); done(false); });
  });
  if (!ready) {
    console.error('dev: o banco não ficou pronto em 120 s; veja a saída [db] acima.');
    shutdown(1);
  }
}

if (!stopping) {
  const migrate = run('migrate', 'npm run db:migrate', { persistent: false });
  const code = await new Promise((r) => migrate.on('exit', r));
  if (code !== 0) {
    console.error('dev: as migrações falharam; veja a saída acima.');
    shutdown(1);
  }
}

if (!stopping) {
  run('api', 'npm run dev -w @oralis/api');
  run('web', 'npm run dev -w @oralis/web');
  console.log(`dev: API em http://localhost:${process.env.API_PORT ?? 3333} · web em http://localhost:3000 · Ctrl+C para parar.`);
}
