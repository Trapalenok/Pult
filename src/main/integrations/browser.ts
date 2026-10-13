import { shell } from 'electron'

export async function openInBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Не http(s) адрес: ${url}`)
  await shell.openExternal(url)
}
