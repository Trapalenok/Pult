import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { VncChannel } from './VncChannel'
import { Button, Field } from './design/components'

export function VncWindow() {
  const target = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const channel = useRef<VncChannel | null>(null)
  const [state, setState] = useState('Подключение…')
  const [required, setRequired] = useState<string[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [serverKey, setServerKey] = useState('')

  useEffect(() => {
    let live = true
    window.api.vncConfig().then((config) => {
      if (!live || !target.current) return
      document.title = config.title
      const transport = new VncChannel()
      channel.current = transport
      const client = new RFB(target.current, transport, { credentials: { username: config.username, password: config.password } })
      rfb.current = client
      client.viewOnly = config.viewOnly
      const cursorClient = client as RFB & { showDotCursor: boolean }
      cursorClient.showDotCursor = true
      client.scaleViewport = true
      client.resizeSession = true
      client.addEventListener('connect', () => { setState('Подключено'); setRequired([]) })
      client.addEventListener('disconnect', (event) => setState(event.detail?.clean ? 'Отключено' : 'Соединение прервано'))
      client.addEventListener('securityfailure', (event) => setState(`Ошибка защиты: ${event.detail?.reason ?? event.detail?.status ?? ''}`))
      client.addEventListener('credentialsrequired', (event) => {
        setUsername(config.username ?? '')
        setRequired(event.detail?.types ?? ['password'])
        setState('Сервер запрашивает учётные данные')
      })
      client.addEventListener('serververification', (event) => {
        const key = event.detail?.publickey as Uint8Array | undefined
        setServerKey(key ? [...key].map((byte) => byte.toString(16).padStart(2, '0')).join(':') : 'Неизвестный ключ')
        setState('Подтвердите ключ VNC-сервера')
      })
      void transport.connect()
    }).catch((error) => setState(String(error)))
    return () => { live = false; rfb.current?.disconnect(); channel.current?.close(); rfb.current = null; channel.current = null }
  }, [])

  return <div className="vnc-window">
    <div className="vnc-window__bar drag"><strong>VNC</strong><span>{state}</span></div>
    <div className="vnc-window__screen" ref={target} />
    {required.length > 0 && <form className="vnc-window__prompt" onSubmit={(event) => { event.preventDefault(); rfb.current?.sendCredentials({ username, password }); setRequired([]); setPassword(''); setState('Проверка данных…') }}>
      <strong>Вход на VNC-сервер</strong>
      {required.includes('username') && <Field autoFocus value={username} placeholder="Пользователь" onChange={(event) => setUsername(event.target.value)} />}
      {required.includes('password') && <Field type="password" autoFocus value={password} placeholder="Пароль" onChange={(event) => setPassword(event.target.value)} />}
      <Button type="submit" variant="filled">Войти</Button>
    </form>}
    {serverKey && <div className="vnc-window__prompt"><strong>Ключ сервера</strong><code>{serverKey}</code><Button variant="filled" onClick={() => { rfb.current?.approveServer(); setServerKey('') }}>Доверять для этого подключения</Button></div>}
  </div>
}
