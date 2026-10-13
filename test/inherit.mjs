// Settings and login along a deep folder chain: npm run test:inherit.
import { effectiveSettings, resolveLogin } from '../src/shared/inherit.ts'
import { inheritFromFolders, moveInto } from '../src/renderer/src/util.ts'

let failed = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// Здание → Этаж → Серверная → Кросс → Полка → хост
const folders = [
  { id: 'b', parentId: null, name: 'Здание', defaults: { credentialId: 'adm', algoProfile: 'legacy' } },
  { id: 'fl', parentId: 'b', name: 'Этаж', defaults: {} },
  { id: 'r', parentId: 'fl', name: 'Серверная', defaults: { port: 2222 } },
  { id: 'x', parentId: 'r', name: 'Кросс', defaults: {} },
  { id: 's', parentId: 'x', name: 'Полка', defaults: {} }
]
const credentials = [{ id: 'adm', name: 'Админ сети', username: 'netadmin' }]
const secrets = ['adm']
const host = (overrides = {}, id = 'h') => ({ id, folderId: 's', name: 'HW5720', address: '10.0.52.46', overrides })

const s = effectiveSettings(folders, host())
eq('port from 3 levels up', s.port, 2222)
eq('algorithms from the top', s.algoProfile, 'legacy')
eq('login from the top', resolveLogin(folders, credentials, host(), secrets), { username: 'netadmin', secretId: 'adm', source: { kind: 'credential', name: 'Админ сети' }, usernameOverride: false })
eq('own username wins, password still from the account above',
  resolveLogin(folders, credentials, host({ username: 'old' }), secrets),
  { username: 'old', secretId: 'adm', source: { kind: 'credential', name: 'Админ сети' }, usernameOverride: true })
eq('own password with the inherited username',
  resolveLogin(folders, credentials, host(), [...secrets, 'h']),
  { username: 'netadmin', secretId: 'h', source: { kind: 'host', name: 'HW5720' }, usernameOverride: false })
const sub = folders.map((f) => (f.id === 'x' ? { ...f, defaults: { username: 'cross' } } : f))
eq('a subfolder username wins over the account above it', resolveLogin(sub, credentials, host(), secrets).username, 'cross')

// "Всё внутри берёт настройки папок"
const store = { folders, credentials, maps: [], hosts: [host({ username: 'old', port: 22, algoProfile: 'compat', winbox: true })], secretIds: ['adm', 'h'] }
const r = inheritFromFolders(store, ['h'], ['r'])
eq('host forgets its own settings', r.store.hosts[0].overrides, {})
eq('own password is deleted', r.ops, [['h', null]])
eq('subfolder forgets its port', r.store.folders.find((f) => f.id === 'r').defaults, {})
eq('afterwards the host inherits', resolveLogin(r.store.folders, credentials, r.store.hosts[0], ['adm']).username, 'netadmin')

// Drag and drop
eq('host moves', moveInto(store, ['h'], [], 'fl').hosts[0].folderId, 'fl')
eq('folder never goes inside itself', moveInto(store, [], ['fl'], 's').folders.find((f) => f.id === 'fl').parentId, 'b')
eq('folder moves to the top', moveInto(store, [], ['r'], null).folders.find((f) => f.id === 'r').parentId, null)
process.exit(failed ? 1 : 0)
