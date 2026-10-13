import { createHash } from 'crypto'

/** Key type from an SSH public key blob: the first length-prefixed string, e.g. "ssh-rsa". */
export function keyType(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString('ascii') || 'unknown'
}

/** Same format OpenSSH prints: SHA256:<base64 without padding>. */
export function fingerprint(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}
