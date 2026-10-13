/** Pure helpers for the network tools: Windows console text and traceroute lines. */

// CP866 bytes 0x80–0xFF. Russian Windows prints ping/tracert in the OEM code page when piped.
const CP866_HIGH =
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ '

/** Single-byte, so chunks can be decoded one by one. ASCII passes through, so English Windows reads fine too. */
export function decodeCp866(buf: Buffer): string {
  let s = ''
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : CP866_HIGH[b - 0x80]
  return s
}

export interface Hop {
  hop: number
  rtts: (number | null)[]
  address?: string
  name?: string
}

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/

/**
 * One hop line of Windows tracert or Linux traceroute:
 *   "  2    <1 мс    1 ms     *     core-sw [10.0.0.1]"
 *   " 3  core-sw (10.0.0.1)  0.512 ms  0.488 ms *"
 *   "  4     *        *        *     Превышен интервал ожидания для запроса."
 * Anything else (header, footer, blank) gives null.
 */
export function parseHop(line: string): Hop | null {
  const m = line.match(/^\s*(\d{1,3})\s+(.*\S)\s*$/)
  if (!m) return null
  const rest = m[2]
  const rtts: (number | null)[] = []
  for (const t of rest.matchAll(/(?<![\w.])(\*|(<)?(\d+(?:[.,]\d+)?)\s*(?:ms|мс|msec)(?=\s|$))/gi)) {
    if (t[1] === '*') rtts.push(null)
    else {
      const v = Number(t[3].replace(',', '.'))
      rtts.push(t[2] ? v / 2 : v)
    }
  }
  if (rtts.length === 0) return null
  // Address: "name [ip]" (Windows), "name (ip)" (Linux), or a bare ip; IPv6 in brackets too.
  const br = rest.match(/([^\s[\]()]+)\s+[[(]([0-9a-f:.]+)[\])]/i)
  if (br) return { hop: Number(m[1]), rtts, name: br[1], address: br[2] }
  const v4 = rest.match(IPV4)
  if (v4) return { hop: Number(m[1]), rtts, address: v4[1] }
  const v6 = rest.match(/(?:^|\s)([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})(?=\s|$)/i)
  return { hop: Number(m[1]), rtts, address: v6?.[1] }
}

/** TTL from a ping reply line ("TTL=64", "ttl=64"). */
export function parseTtl(out: string): number | undefined {
  const m = out.match(/ttl[=:](\d+)/i)
  return m ? Number(m[1]) : undefined
}
