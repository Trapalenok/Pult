import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

const credentialScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
$user = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
$password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
$definition = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PultRdpCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    public static void Save(string target, string user, string password) {
        var credential = new Credential {
            Type = 1, TargetName = target, UserName = user, Persist = 1,
            CredentialBlobSize = (uint)Encoding.Unicode.GetByteCount(password),
            CredentialBlob = Marshal.StringToCoTaskMemUni(password)
        };
        try {
            if (!CredWrite(ref credential, 0))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            Marshal.ZeroFreeCoTaskMemUnicode(credential.CredentialBlob);
        }
    }
}
'@
Add-Type -TypeDefinition $definition
[PultRdpCredential]::Save($target, $user, $password)
`

function singleLine(value: string, label: string): string {
  const result = value.trim()
  if (!result || /[\r\n\0]/.test(result)) throw new Error(`Неверное поле RDP: ${label}`)
  return result
}

export function rdpDestination(address: string, port: number): string {
  const host = singleLine(address, 'адрес')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Неверный порт RDP')
  const server = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return port === 3389 ? server : `${server}:${port}`
}

export function rdpUser(username?: string, domain?: string): string {
  const user = username?.trim() ?? ''
  if (!user) return ''
  if (/[\r\n\0]/.test(user) || (domain && /[\r\n\0]/.test(domain))) throw new Error('Неверный пользователь RDP')
  return domain?.trim() && !user.includes('\\') && !user.includes('@') ? `${domain.trim()}\\${user}` : user
}

export function rdpFile(destination: string, user: string): Buffer {
  const content = `full address:s:${destination}\r\n${user ? `username:s:${user}\r\n` : ''}prompt for credentials:i:0\r\n`
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
}

/** Hand the saved password to the current Windows logon session without putting it in process arguments or an RDP file. */
export async function saveSessionCredential(target: string, user: string, password: string): Promise<void> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(credentialScript, 'utf16le').toString('base64')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { errors += chunk.slice(0, 1000) })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Не удалось передать учётные данные Windows (${code}): ${errors.slice(0, 300)}`)))
    child.stdin.on('error', reject)
    child.stdin.end([target, user, password].map((value) => Buffer.from(value, 'utf8').toString('base64')).join('\n') + '\n')
  })
}

export async function launchMstsc(tempDir: string, address: string, port: number, username?: string, domain?: string, password?: string): Promise<boolean> {
  if (process.platform !== 'win32') throw new Error('Системный RDP-клиент доступен только в Windows')
  const destination = rdpDestination(address, port)
  const user = rdpUser(username, domain)
  let passwordNeedsEntry = !!password && !user
  if (user && password) {
    try { await saveSessionCredential(`TERMSRV/${destination}`, user, password) }
    catch { passwordNeedsEntry = true }
  }
  const file = join(tempDir, `pult-${randomUUID()}.rdp`)
  writeFileSync(file, rdpFile(destination, user), { flag: 'wx', mode: 0o600 })
  try {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mstsc.exe')
    const child = spawn(executable, [file], { windowsHide: false, stdio: 'ignore' })
    child.once('exit', () => { try { unlinkSync(file) } catch { /* already removed */ } })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return passwordNeedsEntry
  } catch (error) {
    try { unlinkSync(file) } catch { /* already removed */ }
    throw error
  }
}
