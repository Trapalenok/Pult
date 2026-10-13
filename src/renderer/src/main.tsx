import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './design/tokens.css'
import './design/components.css'
import './app.css'
import { App } from './App'
import { DetachedWindow } from './DetachedWindow'

document.documentElement.dataset.platform = window.platform

// A popped-out window is the same page with ?session=… in the URL.
const q = new URLSearchParams(location.search)
const sessionId = q.get('session')

createRoot(document.getElementById('root')!).render(
  sessionId ? (
    <DetachedWindow session={{ sessionId, hostId: q.get('host') ?? '', title: q.get('title') ?? 'SSH' }} />
  ) : (
    <App />
  )
)
