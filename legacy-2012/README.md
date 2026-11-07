# Pult Legacy

Та же программа Pult, собранная на Electron 22 (Chromium 108, Node 16.17) для Windows 7, 8.1,
Server 2012 и 2012 R2. Electron 23 и новее на этих системах не запускаются, Electron 22 последний.

## Сборка

```
npm run dist:legacy
```

Скрипт `scripts/build-2012.mjs` копирует `src`, `build` и эту папку в `.build-2012\`, ставит там
Electron 22 (остальные пакеты по `package-lock.json` основной сборки), собирает и кладёт в `dist\`
`Pult-Legacy-Setup-<версия>.exe` и `Pult-Legacy-<версия>-portable.exe`. Основной `node_modules` и
`npm run dist:win` не меняются. Версия та же, что в `package.json`: все правки основной сборки
попадают в Pult Legacy при следующей сборке сами.

## Чем отличается

- Отдельное приложение: «Pult Legacy», appId `local.sshclient.ws2012` (`edition.json`), свой ярлык
  и строка в «Программах». Ставится рядом с Pult и не заменяет его.
- База общая: `%APPDATA%\ssh-client`, как у Pult. Не запускайте обе программы одновременно на одном ПК.
- CSS `color-mix()` в Chromium 108 нет. `color-mix.ts` при сборке меняет каждый `color-mix()` на
  переменную `--cm__…`, а `color-mix-shim.ts` считает её из текущей темы. Выглядит так же.
- Функции все те же. Electron 22 больше не получает обновлений безопасности Chromium, поэтому
  Pult Legacy только для старых серверов в локальной сети.
