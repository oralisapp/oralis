// Restaura exclusivamente em banco NOVO; nunca limpa ou sobrescreve banco existente.
import { constants, existsSync } from 'node:fs';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import pg from 'pg';
import { databaseIdentity, pgTool, quoteIdentifier, validateRestoreTarget, fileSha256, safeBackupFile, verifyDocumentFiles, validateManifest, assertSafePath, triggerCatalogSql, verifyTriggers } from './backup-lib.mjs';
const root=resolve(import.meta.dirname,'..');if(existsSync(join(root,'.env')))process.loadEnvFile(join(root,'.env'));
if(process.argv.includes('--help')) {console.log('RESTORE_DATABASE_URL=postgres://.../oralis_restore_<nome> npm run backup:verify -- .data/backups/<backup>\nCria banco novo, restaura, confere contagens e hashes dos arquivos. Nunca inicia a aplicação no banco restaurado.');process.exit(0);}
const source=process.env.DATABASE_URL,target=process.env.RESTORE_DATABASE_URL,folder=process.argv[2]&&resolve(root,process.argv[2]);
if(!source||!target||!folder)throw Error('Informe pasta do backup e DATABASE_URL/RESTORE_DATABASE_URL.');
const name=validateRestoreTarget(source,target);
const manifest=validateManifest(JSON.parse(await readFile(await safeBackupFile(folder,'manifest.json'),'utf8')));
if(manifest.format!=='oralis-backup-v1'||manifest.sourceIdentity===databaseIdentity(target))throw Error('Manifesto ou destino inválido.');
const hash=fileSha256;
if(await hash(await safeBackupFile(folder,'database.dump'))!==manifest.databaseSha256)throw Error('Checksum do banco não confere.');
const uploads=resolve(root,'.data/restore-verification',name);
for(const f of manifest.files){const path=await safeBackupFile(folder,'files/'+f.key);if(await hash(path)!==f.sha256)throw Error('Checksum de documento não confere.');}
await assertSafePath(uploads);
if(existsSync(uploads))throw Error('A pasta de verificação já existe. Use um nome de destino novo.');
const adminUrl=new URL(target);adminUrl.pathname='/postgres';
const admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:10000});
const restored=new pg.Client({connectionString:target,connectionTimeoutMillis:10000});
try{
 await pgTool('pg_restore',['--version'],target);await admin.connect();
 if((await admin.query('select 1 from pg_database where datname=$1',[name])).rowCount)throw Error('O banco de destino já existe. Use um nome novo.');
 await admin.query(`create database ${quoteIdentifier(name)}`);
 await pgTool('pg_restore',['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',name,join(folder,'database.dump')],target);
 await restored.connect();
 verifyTriggers(manifest.triggers,(await restored.query(triggerCatalogSql)).rows);
 const actualTables=(await restored.query("select schemaname,tablename from pg_tables where schemaname in ('public','drizzle')")).rows;
 const tableKeys=manifest.tables.map(t=>t.schemaname+'.'+t.tablename);
 if(actualTables.length!==tableKeys.length||actualTables.some(t=>!tableKeys.includes(t.schemaname+'.'+t.tablename)))throw Error('Lista de tabelas divergente.');
 if(tableKeys.includes('public.document_versions'))verifyDocumentFiles((await restored.query('select storage_key,sha256 from public.document_versions')).rows,manifest.files);
 await mkdir(resolve(uploads,'..'),{recursive:true});await mkdir(uploads);

 for(const t of manifest.tables){const n=(await restored.query(`select count(*)::text as n from ${quoteIdentifier(t.schemaname)}.${quoteIdentifier(t.tablename)}`)).rows[0].n;if(n!==t.count)throw Error(`Contagem divergente: ${t.schemaname}.${t.tablename}`);}
 for(const f of manifest.files){const dest=resolve(uploads,f.key);if(!dest.startsWith(uploads+sep))throw Error('Caminho de destino inválido.');await mkdir(resolve(dest,'..'),{recursive:true});await copyFile(await safeBackupFile(folder,'files/'+f.key),dest,constants.COPYFILE_EXCL);if(await hash(dest)!==f.sha256)throw Error('Checksum do documento restaurado não confere.');}
 await writeFile(join(uploads,'verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),target:databaseIdentity(target),tables:manifest.tables.length,files:manifest.files.length,triggers:manifest.triggers.length},null,2),{flag:'wx'});
 console.log(`Restauração verificada: ${name}; ${manifest.tables.length} tabelas; arquivos em ${relative(root,uploads)}. Banco mantido para inspeção.`);
}catch(e){console.error(e.message);process.exitCode=1;}finally{await admin.end();await restored.end();}
