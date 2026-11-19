declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: HTMLElement, channel: object, options?: { credentials?: { username?: string; password?: string }; shared?: boolean })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    addEventListener(name: string, cb: (event: CustomEvent<any>) => void): void
    sendCredentials(credentials: { username?: string; password?: string }): void
    approveServer(): void
    disconnect(): void
  }
}
