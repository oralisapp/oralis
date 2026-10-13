import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseIdentity, validateRestoreTarget } from './backup-lib.mjs';

test('identidade normaliza aliases locais, porta padrão e credenciais diferentes', () => {
 assert.equal(databaseIdentity('postgres://a:one@localhost/main'), databaseIdentity('postgresql://b:two@127.0.0.1:5432/main'));
});
test('restauração nunca aceita banco original ou nome genérico', () => {
 assert.throws(() => validateRestoreTarget('postgres://x@localhost/oralis_dev', 'postgres://y@127.0.0.1/oralis_dev'));
 assert.throws(() => validateRestoreTarget('postgres://x@localhost/oralis_dev', 'postgres://x@localhost/production'));
 assert.doesNotThrow(() => validateRestoreTarget('postgres://x@localhost/oralis_dev', 'postgres://x@localhost/oralis_restore_20261006'));
});
import * as lib from './backup-lib.mjs';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('URL não permite query redirecionar conexão nem senha no erro', () => {
 assert.throws(() => lib.databaseIdentity('postgres://u:secret@localhost/main?host=remote'), /parâmetro/i);
 assert.throws(() => lib.databaseIdentity('invalid-secret'), e => !e.message.includes('invalid-secret'));
});
test('ambiente libpq remove overrides herdados e normaliza IPv6', () => {
 const saved = process.env.PGHOSTADDR;
 try {
  process.env.PGHOSTADDR = '203.0.113.1';
  const e = lib.pgEnvironment('postgres://u:p@[::1]/main');
  assert.equal(e.PGHOSTADDR, undefined);
  assert.equal(e.PGHOST, '::1');
 } finally { if(saved===undefined)delete process.env.PGHOSTADDR;else process.env.PGHOSTADDR=saved; }
});
test('validação de documentos rejeita arquivo faltante ou hash distinto', () => {
 assert.throws(() => lib.verifyDocumentFiles([{ storage_key:'a',sha256:'expected' }], []));
 assert.throws(() => lib.verifyDocumentFiles([{ storage_key:'a',sha256:'expected' }], [{key:'a',sha256:'different'}]));
 assert.doesNotThrow(() => lib.verifyDocumentFiles([{ storage_key:'a',sha256:'expected' }], [{key:'a',sha256:'expected'}]));
});
test('caminhos de arquivo recusam traversal, caminhos Windows e links simbólicos', async () => {
 const dir=await mkdtemp(join(tmpdir(),'oralis-backup-test-'));
 try {
  await writeFile(join(dir,'ok'),'abc');
  assert.equal(await lib.safeBackupFile(dir,'ok'),join(dir,'ok'));
  for(const key of ['../outside','C:/outside','a/../../b','/outside','a\\..\\b']) await assert.rejects(() => lib.safeBackupFile(dir,key));
  await mkdir(join(dir,'real'));
  await symlink(join(dir,'real'),join(dir,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(() => lib.safeBackupFile(dir,'link/item'),/simbólico/i);
  assert.equal(await lib.fileSha256(join(dir,'ok')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 } finally { assert.ok(dir.startsWith(join(tmpdir(),'oralis-backup-test-')));await rm(dir,{recursive:true,force:true}); }
});

test('armazenamento não pode englobar os próprios backups', () => {
 assert.throws(()=>lib.ensureSeparateTrees('/app/.data','/app/.data/backups/one'));
 assert.throws(()=>lib.ensureSeparateTrees('/app/.data','/app/.data'));
 assert.doesNotThrow(()=>lib.ensureSeparateTrees('/app/.data/uploads','/app/.data/backups/one'));
});
test('manifesto não pode omitir tabelas, repetir arquivos ou mudar esquema', () => {
 const good={format:'oralis-backup-v1',sourceIdentity:'localhost:5432/main',databaseSha256:'a'.repeat(64),tables:[{schemaname:'public',tablename:'patients',count:'2'}],triggers:[],files:[]};
 assert.doesNotThrow(()=>lib.validateManifest(good));
 assert.throws(()=>lib.validateManifest({...good,tables:[]}));
 assert.throws(()=>lib.validateManifest({...good,tables:[{schemaname:'pg_catalog',tablename:'pg_authid',count:'2'}]}));
 assert.throws(()=>lib.validateManifest({...good,files:[{key:'a',sha256:'a'.repeat(64)},{key:'a',sha256:'a'.repeat(64)}]}));
});

test('verificação detecta gatilho ausente ou desabilitado', () => {
 const expected=[{schema:'public',table:'audit_events',name:'append_only',enabled:'O',definition:'trigger'}];
 assert.doesNotThrow(()=>lib.verifyTriggers(expected,expected));
 assert.throws(()=>lib.verifyTriggers(expected,[]));
 assert.throws(()=>lib.verifyTriggers(expected,[{...expected[0],enabled:'D'}]));
});
