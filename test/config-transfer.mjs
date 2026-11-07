// Real export/import/store code, synthetic credentials, isolated disks and a mock OS keyring.
// No user's database, Electron window or network is accessed.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const temp = mkdtempSync(join(tmpdir(), 'pult-transfer-test-'))
try {
  const bundle = join(temp, 'transfer.mjs')
  await build({
    stdin: { contents: `export * from './src/main/store/transfer';
      export { saveStore, setSecret, getSecret, dumpStore, loadStore, saveAutomaticLldp } from './src/main/store/json-store';
      export { resolveLogin, snmpCommunityOwner, effectiveSettings } from './src/shared/inherit';
      export { readForeign } from './src/main/store/foreign-parse';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle,
    alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'isolated-electron', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        const state = globalThis.__transferTest;
        export const app = { getPath: () => state.dir, getVersion: () => 'test' };
        export const dialog = {
          showSaveDialog: async () => ({ canceled: false, filePath: state.file }),
          showOpenDialog: async () => ({ canceled: false, filePaths: [state.file] })
        };
        export const safeStorage = {
          isEncryptionAvailable: () => true,
          encryptString: s => Buffer.from(state.machine + ':' + s),
          decryptString: b => {
            const s = b.toString();
            if (!s.startsWith(state.machine + ':')) throw Error('Wrong OS keyring');
            return s.slice(state.machine.length + 1);
          }
        };` }))
    } }]
  })
  let serial = 0
  const transferFile = join(temp, 'export.json')
  async function machine(name, file = transferFile) {
    const dir = join(temp, name)
    mkdirSync(dir)
    globalThis.__transferTest = { dir, machine: name, file }
    return { api: await import(pathToFileURL(bundle).href + '?' + serial++), dir }
  }
  const empty = { folders: [], hosts: [], credentials: [], maps: [], workspaces: [] }
  const source = await machine('source')
  const store = {
    ...empty,
    folders: [{ id: 'f', parentId: null, name: 'folder', defaults: { username: 'folder-user', snmp: true } }],
    credentials: [{ id: 'c', name: 'account', username: 'account-user' }],
    hosts: [
      { id: 'h', name: 'own', address: '192.0.2.1', folderId: null, overrides: { username: 'host-user', snmp: true }, lldpAuto: true },
      { id: 'hf', name: 'inherited', address: '192.0.2.2', folderId: 'f', overrides: {} },
      { id: 'hc', name: 'account', address: '192.0.2.3', folderId: null, overrides: { credentialId: 'c' }, lldpAuto: false }
    ]
  }
  source.api.saveStore(store)
  const secrets = { h: 'test-host-secret', f: 'test-folder-secret', c: 'test-account-secret', 'snmp:f': 'test-community', 'snmp:h': 'test-host-community' }
  for (const [id, value] of Object.entries(secrets)) source.api.setSecret(id, value)
  await source.api.exportConfig(null, 'export-password')
  const exported = readFileSync(transferFile, 'utf8')
  for (const value of Object.values(secrets)) assert.ok(!exported.includes(value), 'export does not expose plaintext passwords')
  assert.equal(JSON.parse(exported).secrets.kdf, 'scrypt')

  const dest = await machine('destination')
  dest.api.saveStore(empty)
  const preview = await dest.api.importPick(null)
  assert.equal(preview.hasSecrets, true, 'UI receives the password requirement')
  const before = readFileSync(join(dest.dir, 'store.json'), 'utf8')
  assert.throws(() => dest.api.importApply(preview.token, 'merge'), /Введите пароль/)
  assert.throws(() => dest.api.importApply(preview.token, 'replace', ''), /Введите пароль/)
  assert.throws(() => dest.api.importApply(preview.token, 'merge', 'wrong'), /Неверный пароль/)
  assert.equal(readFileSync(join(dest.dir, 'store.json'), 'utf8'), before, 'failed attempts do not mutate database')
  const imported = dest.api.importApply(preview.token, 'merge', 'export-password')
  for (const [id, value] of Object.entries(secrets)) assert.equal(dest.api.getSecret(id), value)
  assert.equal(imported.hosts[0].lldpAuto, true)
  assert.equal(imported.hosts[2].lldpAuto, false)
  for (const [index, owner] of [[0, 'h'], [1, 'f']]) {
    assert.equal(dest.api.effectiveSettings(imported.folders, imported.hosts[index]).snmp, true)
    assert.equal(dest.api.snmpCommunityOwner(imported.folders, imported.hosts[index], imported.secretIds), owner)
  }
  for (const [i, username, secretId] of [[0, 'host-user', 'h'], [1, 'folder-user', 'f'], [2, 'account-user', 'c']]) {
    const login = dest.api.resolveLogin(imported.folders, imported.credentials, imported.hosts[i], imported.secretIds)
    assert.equal(login.username, username)
    assert.equal(login.secretId, secretId)
  }
  const sourceDisk = JSON.parse(readFileSync(join(source.dir, 'store.json'), 'utf8'))
  const destDisk = JSON.parse(readFileSync(join(dest.dir, 'store.json'), 'utf8'))
  assert.notEqual(sourceDisk.secrets.h, destDisk.secrets.h, 'secrets re-encrypted with destination OS keyring')
  assert.notEqual(sourceDisk.secrets['snmp:h'], destDisk.secrets['snmp:h'])
  const id = { subtype: 4, hex: '001122334455', text: '00:11:22:33:44:55' }
  const lldp = { source: 'snmp', address: '192.0.2.1', observedAt: 1234, chassisId: id, systemName: 'test', neighbors: [] }
  const stale = dest.api.loadStore()
  dest.api.saveAutomaticLldp('h', lldp)
  stale.hosts[0].name = 'user-edit'
  const concurrent = dest.api.saveStore(stale)
  assert.equal(concurrent.hosts[0].name, 'user-edit')
  assert.deepEqual(concurrent.hosts[0].lldp, lldp, 'stale renderer save preserves background result')
  concurrent.hosts[0].lldp = undefined
  assert.equal(dest.api.saveStore(concurrent).hosts[0].lldp, undefined, 'current editor can clear the snapshot')

  // Existing entries are intentionally retained by "Add new", even when their passwords are missing.
  const repeat = await machine('repeat')
  repeat.api.saveStore(store)
  const again = await repeat.api.importPick(null)
  repeat.api.importApply(again.token, 'merge', 'export-password')
  assert.equal(repeat.api.getSecret('h'), undefined)
  const replace = await repeat.api.importPick(null)
  repeat.api.importApply(replace.token, 'replace', 'export-password')
  assert.equal(repeat.api.getSecret('h'), secrets.h, 'replace restores previously skipped passwords')

  await source.api.exportConfig(null)
  const plain = await machine('plain')
  plain.api.saveStore(empty)
  const noSecrets = await plain.api.importPick(null)
  assert.equal(noSecrets.hasSecrets, false)
  const plainImported = plain.api.importApply(noSecrets.token, 'merge')
  assert.equal(plainImported.hosts[0].overrides.username, 'host-user', 'login does not depend on file password')
  assert.deepEqual(plainImported.secretIds, [])

  for (const filename of ['export.json', 'export.txt']) {
    assert.throws(() => dest.api.readForeign(Buffer.from(exported), filename, () => { throw Error('no SQL expected') }), /Перенос конфигурации/)
    assert.throws(() => dest.api.readForeign(Buffer.from(JSON.stringify(sourceDisk)), filename, () => { throw Error('no SQL expected') }), /исходном ПК/)
  }
  console.log('PASS: encrypted cross-machine transfer; required/wrong passwords; host/folder/account logins; SNMP; repeat merge/replace; unencrypted export; wrong import path.')
} finally {
  delete globalThis.__transferTest
  const parent = resolve(tmpdir()) + sep
  if (!resolve(temp).startsWith(parent) || !temp.includes('pult-transfer-test-')) throw Error('Unexpected cleanup path')
  rmSync(temp, { recursive: true, force: true })
}
