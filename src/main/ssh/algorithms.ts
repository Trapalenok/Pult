import type { Algorithms } from 'ssh2'
// ssh2 keeps its default and supported lists here; typed in ssh2-constants.d.ts.
import constants from 'ssh2/lib/protocol/constants.js'
import type { AlgoProfile } from '@shared/types'

const c = constants

/** What old Huawei VRP / Cisco IOS / MikroTik builds still speak. ssh2 supports all of it, just not by default. */
const LEGACY = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  hmac: ['hmac-sha1', 'hmac-sha1-96', 'hmac-md5', 'hmac-md5-96']
} as const

type Kind = keyof typeof LEGACY
const SOURCE: Record<Kind, [defaults: string, supported: string]> = {
  kex: ['DEFAULT_KEX', 'SUPPORTED_KEX'],
  serverHostKey: ['DEFAULT_SERVER_HOST_KEY', 'SUPPORTED_SERVER_HOST_KEY'],
  cipher: ['DEFAULT_CIPHER', 'SUPPORTED_CIPHER'],
  hmac: ['DEFAULT_MAC', 'SUPPORTED_MAC']
}

function list(kind: Kind, profile: AlgoProfile): string[] {
  const [defKey, supKey] = SOURCE[kind]
  const defaults = c[defKey]
  const supported = new Set(c[supKey])
  // The runtime crypto backend (OpenSSL / BoringSSL) may lack e.g. 3des; never hand ssh2 an unsupported name.
  const legacy = LEGACY[kind].filter((a) => supported.has(a) && !defaults.includes(a))
  if (profile === 'modern') return [...defaults]
  // Legacy DH is much slower on older switches. Even in the legacy profile, try a modern
  // key exchange first when the device supports one; old KEX methods stay available as fallback.
  if (profile === 'legacy' && kind === 'kex') return [...defaults, ...legacy]
  // Host key types: the server uses the first one in our list it has a key for. Putting ssh-dss first
  // made a switch that has both an old DSA key and a newer RSA/ECDSA key present the DSA one, so a
  // freshly made key was never used. DSA stays a last resort in every profile.
  if (profile === 'compat' || kind === 'serverHostKey') return [...defaults, ...legacy]
  return [...legacy, ...defaults]
}

/**
 * modern: ssh2 defaults.
 * compat: defaults first, legacy appended, so new servers still negotiate modern algorithms.
 * legacy: old ciphers/MACs first; KEX methods still prefer modern ones for faster handshakes, with
 * old DH available as fallback. Host key types prefer newer keys, with ssh-dss last.
 */
export function algorithmsFor(profile: AlgoProfile): Algorithms {
  return {
    kex: list('kex', profile),
    serverHostKey: list('serverHostKey', profile),
    cipher: list('cipher', profile),
    hmac: list('hmac', profile)
  } as Algorithms
}
