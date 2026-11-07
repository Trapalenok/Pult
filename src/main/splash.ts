import { app, BrowserWindow } from 'electron'

/** build/icon.svg without its metadata: the same logo as the app icon. */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 896 896" width="112" height="112">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5E5CE6"/><stop offset="1" stop-color="#0A6CFF"/></linearGradient>
<linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4ECFF"/></linearGradient>
</defs>
<rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
<g stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="18" stroke-linecap="round">
<line x1="512" y1="300" x2="230" y2="250"/><line x1="512" y1="300" x2="794" y2="250"/>
<line x1="512" y1="560" x2="250" y2="760"/><line x1="512" y1="560" x2="774" y2="760"/>
</g>
<g fill="#FFFFFF"><circle cx="230" cy="250" r="34"/><circle cx="794" cy="250" r="34"/><circle cx="250" cy="760" r="34"/><circle cx="774" cy="760" r="34"/></g>
<g fill="#30D158"><circle cx="230" cy="250" r="16"/><circle cx="794" cy="250" r="16"/><circle cx="250" cy="760" r="16"/></g>
<circle cx="774" cy="760" r="16" fill="#FF9F0A"/>
<path fill="url(#sh)" d="M512 214 L716 290 Q724 293 724 302 L724 486 Q724 676 512 790 Q300 676 300 486 L300 302 Q300 293 308 290 Z"/>
<g stroke="#2F5BFF" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="408,420 486,476 408,532"/><line x1="530" y1="562" x2="618" y2="562"/></g>
</svg>`

/** Pult Legacy uses Electron 22, the last one for Windows 7 / Server 2012. */
const EDITION = Number(process.versions.electron.split('.')[0]) <= 22 ? 'Pult Legacy' : 'Pult'

// Plain CSS only (Chromium 108 in Pult Legacy: no color-mix, no nesting). Nothing here loads from anywhere.
const page = () => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;overflow:hidden;-webkit-user-select:none;user-select:none;cursor:default}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
 background:radial-gradient(120% 90% at 50% 0%,#232a3d 0%,#14161c 70%);color:#f1f3f7;
 font-family:"Segoe UI",system-ui,sans-serif;-webkit-app-region:drag}
.logo{animation:in .45s cubic-bezier(.2,.8,.2,1) both}
h1{margin:4px 0 0;font-size:26px;font-weight:600;letter-spacing:.2px;animation:in .45s .08s cubic-bezier(.2,.8,.2,1) both}
p{margin:0;font-size:12.5px;color:#9aa3b5;animation:in .45s .14s cubic-bezier(.2,.8,.2,1) both}
.bar{position:relative;width:160px;height:3px;margin-top:10px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden}
.bar:after{content:"";position:absolute;top:0;left:-40%;width:40%;height:100%;border-radius:2px;background:linear-gradient(90deg,#5E5CE6,#0A6CFF);animation:run 1.1s ease-in-out infinite}
.ver{position:absolute;bottom:12px;font-size:11px;color:#5d6577}
@keyframes in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
@keyframes run{from{left:-40%}to{left:100%}}
</style></head><body>
<div class="logo">${LOGO}</div>
<h1>${EDITION}</h1>
<p>Загружаю хосты и настройки…</p>
<div class="bar"></div>
<div class="ver">версия ${app.getVersion()}</div>
</body></html>`

const splashes = new WeakSet<BrowserWindow>()
/** The logo window has no title bar overlay and keeps its own colours. */
export const isSplash = (w: BrowserWindow) => splashes.has(w)

/** Shown at least this long, so a fast start does not just flash it. */
const MIN_MS = 1200
/** The main window shows by then even if it never says it is ready. */
const MAX_MS = 10000

/**
 * A small window with the logo while the main one loads, like Termius. The main window is created hidden
 * and shown once its UI has the base loaded ('app:ready'), then this one goes.
 */
export function showSplash(main: BrowserWindow, ready: (cb: () => void) => void): void {
  const splash = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: EDITION,
    backgroundColor: '#14161c',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  splashes.add(splash)
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  splash.webContents.on('will-navigate', (e) => e.preventDefault())
  let shownAt: number | undefined
  let mainReady = false
  let done = false
  const swap = () => {
    if (done) return
    done = true
    if (!main.isDestroyed()) main.show()
    if (!splash.isDestroyed()) splash.destroy()
  }
  /** The main window is ready: swap once the logo has been on screen MIN_MS (it may not be shown yet). */
  const finish = () => {
    mainReady = true
    if (shownAt !== undefined) setTimeout(swap, Math.max(0, MIN_MS - (Date.now() - shownAt)))
  }
  splash.once('ready-to-show', () => {
    if (done) return
    splash.show()
    shownAt = Date.now()
    if (mainReady) finish()
  })
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page())}`)
  ready(finish)
  setTimeout(swap, MAX_MS)
  // Closing the splash (Alt + F4) does not stop the start; closing the main window takes the splash too.
  main.once('closed', () => !splash.isDestroyed() && splash.destroy())
}
