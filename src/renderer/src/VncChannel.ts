/** noVNC's raw-channel interface, backed by Electron IPC and a direct TCP socket. No WebSocket is opened. */
export class VncChannel {
  binaryType = 'arraybuffer'
  protocol = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: Error) => void) | null = null
  private sessionId: string | null = null
  private offData: (() => void) | null = null
  private offClosed: (() => void) | null = null

  constructor() {
    this.offData = window.api.onVncData((id, data) => {
      if (id !== this.sessionId || this.readyState !== 1) return
      const bytes = new Uint8Array(data)
      this.onmessage?.({ data: bytes.buffer })
    })
    this.offClosed = window.api.onVncClosed((id) => {
      if (id !== this.sessionId) return
      this.finish(1006, 'TCP-соединение закрыто')
    })
  }

  async connect(): Promise<void> {
    try {
      const id = await window.api.vncStart()
      if (this.readyState !== 0) { window.api.vncClose(id); return }
      this.sessionId = id
      this.readyState = 1
      this.onopen?.()
      window.api.vncReady(id)
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      this.finish(1006, String(error))
    }
  }

  send(data: ArrayBuffer): void {
    if (this.sessionId && this.readyState === 1) window.api.vncSend(this.sessionId, data)
  }

  close(): void {
    if (this.sessionId) window.api.vncClose(this.sessionId)
    this.finish(1000, 'Закрыто пользователем')
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.offData?.()
    this.offClosed?.()
    this.onclose?.({ code, reason })
  }
}
