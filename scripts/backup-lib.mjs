import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, parse, relative, sep } from 'node:path';

function pgUrl(value) {
 let u;
 try { u = new URL(value); } catch { throw Error('URL PostgreSQL inválida.'); }
 if (!['postgres:', 'postgresql:'].includes(u.protocol) || !u.hostname || !u.username || !u.pathname.slice(1) || u.hash) throw Error('URL PostgreSQL inválida.');
 // A identidade validada precisa ser a mesma usada pelo pg e pelo libpq.
 for (const key of u.searchParams.keys()) if(key !== 'sslmode') throw Error('Parâmetro de conexão não suportado; use host, porta e banco na URL e apenas sslmode na query.');
 if(u.searchParams.has('sslmode') && !['disable','allow','prefer','require','verify-ca','verify-full','no-verify'].includes(u.searchParams.get('sslmode'))) throw Error('sslmode inválido.');
 if(u.searchParams.get('sslmode') === 'no-verify') throw Error('Use um sslmode compatível com libpq.');
 return u;
}
export function databaseIdentity(value) {
 const u = pgUrl(value);
 const host = ['localhost','127.0.0.1','[::1]'].includes(u.hostname) ? 'loopback' : u.hostname.toLowerCase();
 return `${host}:${u.port || '5432'}/${decodeURIComponent(u.pathname.slice(1))}`;
}
export function validateRestoreTarget(source, target) {
 if (databaseIdentity(source) === databaseIdentity(target)) throw new Error('O destino não pode ser o banco original.');
 const name = decodeURIComponent(pgUrl(target).pathname.slice(1));
 if (!/^oralis_restore_[a-z0-9_]{1,40}$/.test(name)) throw new Error('Use um banco novo com prefixo oralis_restore_.');
 return name;
}
export function pgEnvironment(url) {
 const u = pgUrl(url);
 // Não herdar hostaddr, service, options ou outras opções libpq capazes de
 // redirecionar a conexão ou mudar o comportamento dos comandos.
 const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('PG')));
 return { ...base, PGHOST: u.hostname.replace(/^\[|\]$/g,''), PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)), PGCONNECT_TIMEOUT: '10', ...(u.searchParams.has('sslmode') ? { PGSSLMODE: u.searchParams.get('sslmode') } : {}) };
}
export function pgTool(tool, args, url) {
 const executable = process.env.PG_BIN ? resolve(process.env.PG_BIN, tool + (process.platform === 'win32' ? '.exe' : '')) : tool;
 return new Promise((yes,no) => {
  // Saída do PostgreSQL pode conter valores clínicos/segredos em mensagens de
  // falha. Não propagar stderr nem acumular dumps na memória.
  const child = spawn(executable,args,{env:pgEnvironment(url),windowsHide:true,stdio:'ignore'});
  child.on('error',e=>no(new Error(e.code==='ENOENT' ? `${tool} não encontrado. Instale os clientes PostgreSQL compatíveis e configure PG_BIN.` : `Não foi possível iniciar ${tool}.`)));
  child.on('close',code=>code===0?yes():no(new Error(`${tool} falhou (código ${code}). Confira versão do cliente, conexão e permissões.`)));
 });
}
export const quoteIdentifier = name => '"'+name.replaceAll('"','""')+'"';
export async function fileSha256(path) {
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path)) hash.update(chunk);
 return hash.digest('hex');
}
export async function safeBackupFile(root,key) {
 if(typeof key!=='string' || !key || /[\\:\0]/.test(key) || key.split('/').some(s=>!s||s==='.'||s==='..')) throw Error('Caminho de arquivo inválido.');
 await assertSafePath(root);
 let current=resolve(root);
 for(const part of [null,...key.split('/')]) {
  if(part!==null)current=join(current,part);
  const stat=await lstat(current);
  if(stat.isSymbolicLink()) throw Error('Link simbólico não permitido no backup.');
 }
 return current;
}
export function verifyDocumentFiles(documents, files) {
 const hashes=new Map(files.map(f=>[f.key,f.sha256]));
 for(const d of documents) if(hashes.get(d.storage_key)!==d.sha256) throw Error('Documento referenciado no banco ausente ou com checksum divergente.');
}
export function validateManifest(m) {
 const hash=h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h);
 if(m?.format!=='oralis-backup-v1'||typeof m.sourceIdentity!=='string'||!hash(m.databaseSha256)||!Array.isArray(m.tables)||!m.tables.length||!Array.isArray(m.triggers)||!Array.isArray(m.files))throw Error('Manifesto inválido.');
 for(const t of m.triggers)if(!t||!['public','drizzle'].includes(t.schema)||typeof t.table!=='string'||typeof t.name!=='string'||typeof t.definition!=='string'||!['O','D','R','A'].includes(t.enabled))throw Error('Gatilho inválido no manifesto.');
 const tables=new Set(), files=new Set();
 for(const t of m.tables){const key=t.schemaname+'.'+t.tablename;if(!['public','drizzle'].includes(t.schemaname)||typeof t.tablename!=='string'||!t.tablename||!/^\d+$/.test(t.count)||tables.has(key))throw Error('Tabela inválida no manifesto.');tables.add(key);}
 for(const f of m.files){if(typeof f.key!=='string'||!hash(f.sha256)||files.has(f.key))throw Error('Arquivo inválido no manifesto.');files.add(f.key);}
 return m;
}

export async function assertSafePath(path) {
 const absolute=resolve(path), volume=parse(absolute).root;
 let current=volume;
 for(const part of absolute.slice(volume.length).split(sep).filter(Boolean)) {
  current=join(current,part);
  let stat;
  try { stat=await lstat(current); } catch(e) { if(e.code==='ENOENT')return;throw e; }
  if(stat.isSymbolicLink())throw Error('Link simbólico não permitido no caminho.');
 }
}
export function ensureSeparateTrees(storage,backup) {
 const r=relative(resolve(storage),resolve(backup));
 if(!r || (!r.startsWith('..'+sep)&&r!=='..'&&!parse(r).root))throw Error('O armazenamento não pode conter a pasta de backups.');
}

export const triggerCatalogSql = "select n.nspname as schema, c.relname as table, t.tgname as name, t.tgenabled as enabled, pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','drizzle') order by n.nspname,c.relname,t.tgname";
export function verifyTriggers(expected,actual) {
 if(!Array.isArray(expected)||JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Gatilhos restaurados divergentes.');
}
