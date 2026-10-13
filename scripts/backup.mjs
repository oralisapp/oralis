// Backup lógico PostgreSQL + documentos privados. Nunca imprime URLs com senha.
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import pg from 'pg';
import { databaseIdentity, pgTool, quoteIdentifier, fileSha256, safeBackupFile, verifyDocumentFiles, assertSafePath, ensureSeparateTrees, triggerCatalogSql } from './backup-lib.mjs';
const root = resolve(import.meta.dirname, '..');
if (existsSync(join(root,'.env'))) process.loadEnvFile(join(root,'.env'));
if (process.argv.includes('--help')) { console.log('npm run backup\nUsa DATABASE_URL, STORAGE_DIR e PG_BIN (opcional). Salva em .data/backups. Inclua ENCRYPTION_KEY em um cofre separado.'); process.exit(0); }
const url=process.env.DATABASE_URL;
if (!url) throw Error('DATABASE_URL ausente.');
databaseIdentity(url);
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const folder=resolve(root,'.data/backups',stamp+'-'+randomUUID().slice(0,8));
if (process.env.STORAGE_DRIVER === 's3') {
  // Os documentos estão no bucket, não no disco: este script não os copiaria.
  console.error('backup: STORAGE_DRIVER=s3. Este script só copia documentos do disco local. Use o backup do provedor do banco e o versionamento/replicação do bucket (veja docs/08-deploy.md).');
  process.exit(1);
}
const storage=resolve(root,process.env.STORAGE_DIR || '.data/uploads');
ensureSeparateTrees(storage,folder);
await assertSafePath(folder);await assertSafePath(storage);
await mkdir(folder,{recursive:true});
const client=new pg.Client({connectionString:url,connectionTimeoutMillis:10000});
const checksum=fileSha256;
try {
 await pgTool('pg_dump',['--version'],url);
 await client.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const snapshot=(await client.query('select pg_export_snapshot() as id')).rows[0].id;
 const tables=(await client.query("select schemaname, tablename from pg_tables where schemaname in ('public','drizzle') order by schemaname,tablename")).rows;
 const triggers=(await client.query(triggerCatalogSql)).rows;
 const counts=[];
 for(const t of tables) counts.push({...t,count:(await client.query(`select count(*)::text as n from ${quoteIdentifier(t.schemaname)}.${quoteIdentifier(t.tablename)}`)).rows[0].n});
 const documents=tables.some(t=>t.schemaname==='public'&&t.tablename==='document_versions') ? (await client.query('select storage_key, sha256 from public.document_versions')).rows : [];
 await pgTool('pg_dump',['--format=custom','--no-owner','--no-privileges',`--snapshot=${snapshot}`,`--file=${join(folder,'database.dump')}`],url);

 const files=[];
 async function copyTree(dir) {
  for(const e of await readdir(dir,{withFileTypes:true})) {
   if(e.isSymbolicLink()) throw Error('Link simbólico no armazenamento: revisão manual necessária.');
   const path=join(dir,e.name); if(e.isDirectory()) await copyTree(path); else if(e.isFile()) {
    const key=relative(storage,path).replaceAll('\\','/');await safeBackupFile(storage,key);const dest=join(folder,'files',key);
    await mkdir(resolve(dest,'..'),{recursive:true});await copyFile(path,dest);files.push({key,sha256:await checksum(dest)});
   }
  }
 }
 if(existsSync(storage)) await copyTree(storage);
 verifyDocumentFiles(documents,files);
 await client.query('COMMIT');
 await writeFile(join(folder,'manifest.json'),JSON.stringify({format:'oralis-backup-v1',createdAt:new Date().toISOString(),sourceIdentity:databaseIdentity(url),databaseSha256:await checksum(join(folder,'database.dump')),tables:counts,triggers,files},null,2));
 console.log(`Backup concluído: ${relative(root,folder)} (${counts.length} tabelas, ${files.length} arquivos).`);
} catch(e) { console.error(e.message);process.exitCode=1; } finally {await client.end();}
