import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
import '@xterm/xterm/css/xterm.css'
import './design/tokens.css'
import './design/components.css'
import './app.css'
import './design/ferrum.css'
import { App } from './App'
import { DetachedWindow } from './DetachedWindow'
const VncWindow = lazy(() => import('./VncWindow').then((m) => ({ default: m.VncWindow })))

document.documentElement.dataset.platform = window.platform

// A popped-out window is the same page with ?session=… in the URL.
const q = new URLSearchParams(location.search)
const sessionId = q.get('session')

createRoot(document.getElementById('root')!).render(<Suspense fallback={null}>
  {q.has('vnc') ? <VncWindow /> : sessionId ? (
    <DetachedWindow session={{ sessionId, hostId: q.get('host') ?? '', title: q.get('title') ?? 'SSH', address: q.get('address') ?? undefined }} />
  ) : (
    <App />
  )}
</Suspense>)
