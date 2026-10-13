import { spawn } from 'child_process'
import { existsSync } from 'fs'

/**
 * WinBox 3.x/4.x: `winbox64.exe <address> [<login> [<password>]]`.
 * The password is visible in the process list; the caller decides whether to pass it.
 * On Linux, winboxPath can point at a wrapper script that runs WinBox under Wine.
 */
export function launchWinbox(winboxPath: string, address: string, login?: string, password?: string): void {
  if (!existsSync(winboxPath)) throw new Error(`WinBox не найден: ${winboxPath}`)
  const args = [address, ...(login ? [login] : []), ...(login && password ? [password] : [])]
  spawn(winboxPath, args, { detached: true, stdio: 'ignore' }).unref()
}
