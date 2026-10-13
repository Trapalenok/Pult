import crypto, { createHash, type KeyObject } from 'crypto'

/**
 * Electron ships BoringSSL, which has no DSA: crypto.verify on an ssh-dss host key throws
 * UNSUPPORTED_ALGORITHM, and ssh2 reports that as "Handshake failed: signature verification failed".
 * Old Huawei VRP switches often have only a DSA host key, so the check is done here in plain BigInt
 * math (FIPS 186: w = s⁻¹, u1 = H·w, u2 = r·w, v = (g^u1 · y^u2 mod p) mod q, valid when v = r).
 * Only verification, only when BoringSSL refused the key; nothing is signed with DSA.
 *
 * Must run before ssh2 is loaded: ssh2 destructures crypto.verify at require time.
 */

/** Minimal DER reader: enough for a DSA SubjectPublicKeyInfo and a DSA signature. */
class Der {
  private buf: Buffer
  private pos = 0

  constructor(buf: Buffer) {
    this.buf = buf
  }

  private header(tag: number): number {
    if (this.buf[this.pos++] !== tag) throw new Error('DER: unexpected tag')
    let len = this.buf[this.pos++]
    if (len & 0x80) {
      const n = len & 0x7f
      if (n < 1 || n > 4) throw new Error('DER: bad length')
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + this.buf[this.pos++]
    }
    if (this.pos + len > this.buf.length) throw new Error('DER: truncated')
    return len
  }

  seq(): Der {
    const len = this.header(0x30)
    const inner = new Der(this.buf.subarray(this.pos, this.pos + len))
    this.pos += len
    return inner
  }

  int(): bigint {
    const len = this.header(0x02)
    const hex = this.buf.subarray(this.pos, this.pos + len).toString('hex')
    this.pos += len
    return hex ? BigInt('0x' + hex) : 0n
  }

  oid(): string {
    const len = this.header(0x06)
    const hex = this.buf.subarray(this.pos, this.pos + len).toString('hex')
    this.pos += len
    return hex
  }

  bitString(): Der {
    const len = this.header(0x03)
    // First byte: number of unused bits, always 0 here.
    const inner = new Der(this.buf.subarray(this.pos + 1, this.pos + len))
    this.pos += len
    return inner
  }
}

// 1.2.840.10040.4.1 (id-dsa)
const DSA_OID = '2a8648ce380401'

interface DsaKey {
  p: bigint
  q: bigint
  g: bigint
  y: bigint
}

/** p, q, g, y from an SPKI public key (PEM string, DER buffer or KeyObject), or null if it is not DSA. */
export function dsaPublicKey(key: unknown): DsaKey | null {
  try {
    let der: Buffer
    if (typeof key === 'string') {
      const m = key.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/)
      if (!m) return null
      der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
    } else if (Buffer.isBuffer(key)) der = key
    else if (key && typeof key === 'object' && 'key' in key) return dsaPublicKey((key as { key: unknown }).key)
    else return null
    const spki = new Der(der).seq()
    const alg = spki.seq()
    if (alg.oid() !== DSA_OID) return null
    const params = alg.seq()
    const p = params.int()
    const q = params.int()
    const g = params.int()
    const y = spki.bitString().int()
    return { p, q, g, y }
  } catch {
    return null
  }
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return result
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const qt = oldR / r
    ;[oldR, r] = [r, oldR - qt * r]
    ;[oldS, s] = [s, oldS - qt * s]
  }
  return ((oldS % m) + m) % m
}

const bitLength = (n: bigint) => n.toString(2).length

/** Verifies a DER (r, s) DSA signature of data hashed with `algorithm` (sha1 for ssh-dss). */
export function dsaVerify(algorithm: string, data: Buffer, key: DsaKey, signature: Buffer): boolean {
  const { p, q, g, y } = key
  let r: bigint, s: bigint
  try {
    const sig = new Der(signature).seq()
    r = sig.int()
    s = sig.int()
  } catch {
    return false
  }
  if (r <= 0n || r >= q || s <= 0n || s >= q) return false
  const digest = createHash(algorithm).update(data).digest()
  // Leftmost min(N, outlen) bits of the hash, N = bit length of q.
  let z = BigInt('0x' + digest.toString('hex'))
  const excess = digest.length * 8 - bitLength(q)
  if (excess > 0) z >>= BigInt(excess)
  const w = modInverse(s, q)
  const u1 = (z * w) % q
  const u2 = (r * w) % q
  const v = ((modPow(g, u1, p) * modPow(y, u2, p)) % p) % q
  return v === r
}

type Verify = typeof crypto.verify
const native: Verify = crypto.verify

crypto.verify = ((algorithm: string | null | undefined, data: NodeJS.ArrayBufferView, key: unknown, signature: NodeJS.ArrayBufferView, callback?: (err: Error | null, ok: boolean) => void) => {
  try {
    return (native as any)(algorithm, data, key as KeyObject, signature, callback)
  } catch (err) {
    const dsa = callback ? null : dsaPublicKey(key)
    if (!dsa) throw err
    return dsaVerify(algorithm ?? 'sha1', Buffer.from(data.buffer, data.byteOffset, data.byteLength), dsa, Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength))
  }
}) as Verify
