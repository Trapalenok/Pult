// node --experimental-strip-types test/foreign-import.mjs
// Import from other programs' bases: SQLite with a folders table, cp1251 CSV, nested JSON.
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import { buildImport, decodeText, previewTables, readForeign, splitAddress } from '../src/main/store/foreign-parse.ts'

const SQL = await initSqlJs()
let n = 0
const id = () => `id${++n}`
const empty = { folders: [], hosts: [], credentials: [], maps: [] }

// A web SSH manager's base: folders with parents, servers pointing at them by id.
const db = new SQL.Database()
db.run(`CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER);
  CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT, ip TEXT, port INTEGER, protocol TEXT, username TEXT, password TEXT, folderId INTEGER);
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT);
  INSERT INTO folders VALUES (1,'Главный офис',NULL),(2,'Серверная',1);
  INSERT INTO servers VALUES (1,'sw-core','10.0.0.1',22,'ssh','admin','s3cret',2),
    (2,'gw','10.0.0.2',2222,'ssh','root','pw',1),(3,'win','10.0.0.3',3389,'rdp','adm','x',1),
    (4,'sw-core-dup','10.0.0.1',22,'ssh','admin','s3cret',2);
  INSERT INTO users VALUES (1,'web','$2b$10$abcdefghijklmnopqrstuv');`)
const file = await readForeign(db.export(), 'nexterm.db', async () => SQL)
assert.equal(file.format, 'sqlite')
const pv = previewTables(file)
assert.equal(pv.bestTable, 'servers')
const servers = pv.tables.find((t) => t.name === 'servers')
assert.deepEqual(servers.guess, { address: 'ip', name: 'name', port: 'port', username: 'username', password: 'password', folder: 'folderId', protocol: 'protocol' })
assert.equal(servers.sample[0][servers.columns.indexOf('password')], '••••••', 'passwords are masked in the preview')

const cur = { ...empty, hosts: [{ id: 'old', folderId: null, name: 'gw', address: '10.0.0.2', overrides: { port: 2222 } }] }
const r = buildImport(cur, file, { table: 'servers', mapping: servers.guess, targetFolderId: null, newFolder: 'Nexterm', duplicates: 'skip' }, id)
assert.equal(r.plan.hosts, 1)
assert.equal(r.plan.duplicates, 2, 'gw is already here, sw-core-dup repeats sw-core')
assert.equal(r.plan.notSsh, 1)
assert.equal(r.plan.folderLookup, 'folders')
assert.equal(r.plan.sample[0].folder, 'Nexterm / Главный офис / Серверная')
const h = r.store.hosts.find((x) => x.name === 'sw-core')
assert.deepEqual(h.overrides, { username: 'admin' })
assert.equal(r.secrets[h.id], 's3cret')
assert.equal(r.plan.passwordsLookEncrypted, false)
assert.equal(r.store.folders.length, 3)

// Re-import into the same folder: folders are reused, everything is a duplicate.
const again = buildImport({ ...r.store }, file, { table: 'servers', mapping: servers.guess, targetFolderId: null, newFolder: 'nexterm', duplicates: 'skip' }, id)
assert.equal(again.plan.hosts, 0)
assert.equal(again.plan.folders, 0)

// Russian Excel CSV: cp1251, semicolons, quoted cells, "host:port" in one column.
const csv = 'Имя;IP-адрес;Логин;Пароль;Группа\r\n"Коммутатор ""А""";192.168.1.10:2022;admin;123;Офис/Этаж 2\r\nРоутер;192.168.1.1;;;\r\n'
const enc = (s) => Buffer.from([...s].map((c) => { const k = c.charCodeAt(0); return k >= 0x410 && k <= 0x44f ? k - 0x410 + 0xc0 : k === 0x401 ? 0xa8 : k === 0x451 ? 0xb8 : k }))
assert.equal(decodeText(enc('Привет')), 'Привет')
const cf = await readForeign(enc(csv), 'hosts.csv', async () => SQL)
const ct = previewTables(cf).tables[0]
assert.deepEqual(ct.guess, { address: 'IP-адрес', name: 'Имя', username: 'Логин', password: 'Пароль', folder: 'Группа' })
const cr = buildImport(empty, cf, { table: ct.name, mapping: ct.guess, targetFolderId: null, duplicates: 'skip' }, id)
assert.equal(cr.plan.hosts, 2)
assert.deepEqual(cr.store.hosts[0].overrides, { port: 2022, username: 'admin' })
assert.equal(cr.store.hosts[0].name, 'Коммутатор "А"')
assert.equal(cr.plan.sample[0].folder, 'Офис / Этаж 2')
assert.equal(cr.store.hosts[1].folderId, null)
assert.equal(cr.plan.passwords, 1)

// JSON export with nested credentials and a groups map.
const json = JSON.stringify({ version: 2, hosts: [
  { label: 'core', hostname: 'core.lan', ssh: { port: 22 }, credentials: { username: 'u', password: 'p' }, group: 'DC' },
  { label: 'edge', hostname: 'ubuntu@10.1.1.1', group: 'DC' }
] })
const jf = await readForeign(Buffer.from(json), 'export.json', async () => SQL)
const jt = previewTables(jf)
assert.equal(jt.bestTable, 'hosts')
const g = jt.tables[0].guess
assert.equal(g.address, 'hostname')
assert.equal(g.name, 'label')
assert.equal(g.username, 'credentials.username')
assert.equal(g.port, 'ssh.port')
const jr = buildImport(empty, jf, { table: 'hosts', mapping: g, targetFolderId: null, duplicates: 'add' }, id)
assert.equal(jr.store.hosts[1].address, '10.1.1.1')
assert.equal(jr.store.hosts[1].overrides.username, 'ubuntu')
assert.equal(jr.plan.folders, 1)

assert.deepEqual(splitAddress('[fe80::1]:22'), { address: 'fe80::1', port: 22, username: undefined })

// Hashed passwords are flagged.
const hf = await readForeign(Buffer.from('host,password\n1.1.1.1,$2b$10$abcdefghijklmnopqrstuv\n'), 'x.csv', async () => SQL)
const hr = buildImport(empty, hf, { table: hf.tables[0].name, mapping: { address: 'host', password: 'password' }, targetFolderId: null, duplicates: 'skip' }, id)
assert.equal(hr.plan.passwordsLookEncrypted, true)

assert.throws(() => readForeign(Buffer.from('garbage'), 'enc.sqlite', async () => SQL), /SQLCipher/)
console.log('foreign import: ok')

// One device with several addresses in one cell: the first is the main one, the rest go to addresses.
{
  const mf = await readForeign(Buffer.from('name;ip\r\nsw-multi;"10.9.0.1, 10.9.1.1 10.9.2.1, 10.9.3.1"\r\nsw-one;10.9.0.5\r\n'), 'multi.csv', async () => SQL)
  const mt = previewTables(mf).tables[0]
  const mr = buildImport(empty, mf, { table: mt.name, mapping: { name: 'name', address: 'ip' }, targetFolderId: null, duplicates: 'skip' }, id)
  const multi = mr.store.hosts.find((x) => x.name === 'sw-multi')
  assert.equal(multi.address, '10.9.0.1')
  assert.deepEqual(multi.addresses, ['10.9.1.1', '10.9.2.1'], 'at most two extra addresses')
  assert.equal(mr.store.hosts.find((x) => x.name === 'sw-one').addresses, undefined)
}
