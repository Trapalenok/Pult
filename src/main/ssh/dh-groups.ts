import crypto from 'crypto'

/**
 * Electron ships BoringSSL, which drops the 768/1024-bit MODP groups. ssh2 asks for "modp2" to run
 * diffie-hellman-group1-sha1, the only KEX on many old Huawei VRP / Cisco IOS images, and fails with
 * "Unknown DH group". We hand it the RFC 2409 primes through createDiffieHellman, which BoringSSL still accepts.
 *
 * Must run before ssh2 is loaded: ssh2 destructures createDiffieHellmanGroup at require time.
 */
const RFC2409: Record<string, string> = {
  // Oakley Group 1, 768-bit
  modp1:
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A3620FFFFFFFFFFFFFFFF',
  // Oakley Group 2, 1024-bit
  modp2:
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF'
}

const native = crypto.createDiffieHellmanGroup
crypto.createDiffieHellmanGroup = ((name: string) => {
  try {
    return native(name)
  } catch (err) {
    const prime = RFC2409[name]
    if (!prime) throw err
    return crypto.createDiffieHellman(Buffer.from(prime, 'hex'), 2)
  }
}) as typeof crypto.createDiffieHellmanGroup
