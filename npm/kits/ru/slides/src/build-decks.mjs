#!/usr/bin/env node
// Compose SDD decks: template + color tokens + slide JSON -> standalone HTML + artifact-body HTML.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, 'deck-template.html')
const CONTENT = join(HERE, 'content')   // <key>.json  -> array of slides
const DIST = join(HERE, 'dist')
mkdirSync(DIST, { recursive: true })

const THEMES = {
  leadership: {
    light: { bg:'#E8ECF3', stage:'#FCFDFF', ink:'#12151C', muted:'#55607A', faint:'#8A93A8', line:'#E4E8F1', accent:'#4B57D8', accent2:'#313BA6', accentSoft:'rgba(75,87,216,0.10)', accentInk:'#ffffff' },
    dark:  { bg:'#090B10', stage:'#12151D', ink:'#EAEDF4', muted:'#98A2B6', faint:'#606A80', line:'#242A3A', accent:'#8C95F2', accent2:'#AAB1F6', accentSoft:'rgba(140,149,242,0.15)', accentInk:'#0b0d13' },
  },
  team: {
    light: { bg:'#E6EEEC', stage:'#FBFDFD', ink:'#10201C', muted:'#4E6560', faint:'#8AA39C', line:'#DDE9E6', accent:'#0E9488', accent2:'#0B6E63', accentSoft:'rgba(14,148,136,0.10)', accentInk:'#ffffff' },
    dark:  { bg:'#060B0A', stage:'#0F1614', ink:'#E7EFEC', muted:'#92A8A2', faint:'#5C726C', line:'#1E2A27', accent:'#3FD3C0', accent2:'#6FE0D2', accentSoft:'rgba(63,211,192,0.15)', accentInk:'#05100D' },
  },
}
THEMES._sample = THEMES.leadership

const META = {
  leadership: { title:'Переход на SDD с ИИ-агентами', deckLabel:'Для руководства', docTitle:'SDD — презентация для руководства' },
  team:       { title:'Как мы теперь работаем: SDD', deckLabel:'Для команды',      docTitle:'SDD — онбординг команды' },
  _sample:    { title:'Sample — все layout', deckLabel:'Проверка', docTitle:'Sample deck' },
}

function vars(t){
  return [
    `--bg:${t.bg}`,`--stage:${t.stage}`,`--ink:${t.ink}`,`--muted:${t.muted}`,
    `--faint:${t.faint}`,`--line:${t.line}`,`--accent:${t.accent}`,`--accent-2:${t.accent2}`,
    `--accent-soft:${t.accentSoft}`,`--accent-ink:${t.accentInk}`,
  ].join(';')+';'
}
function tokensCss(theme){
  const L = vars(theme.light), D = vars(theme.dark)
  return [
    `:root{${L}}`,
    `@media (prefers-color-scheme:dark){:root{${D}}}`,
    `:root[data-theme="light"]{${L}}`,
    `:root[data-theme="dark"]{${D}}`,
  ].join('\n')
}

function safeJson(obj){
  // embed safely inside <script>: neutralize </script> and JS line separators
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
}

function build(key, slides){
  const tpl = readFileSync(TEMPLATE, 'utf8')
  const theme = THEMES[key] || THEMES.leadership
  const meta = META[key] || { title:key, deckLabel:'', docTitle:key }
  const inner = tpl
    .replace('/*__TOKENS_CSS__*/', tokensCss(theme))
    .replace('/*__META_JSON__*/{}', safeJson(meta))
    .replace('/*__SLIDES_JSON__*/[]', safeJson(slides))

  for (const marker of ['__TOKENS_CSS__','__META_JSON__','__SLIDES_JSON__']) {
    if (inner.includes(marker)) throw new Error(`unreplaced placeholder ${marker} in ${key}`)
  }
  const full = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${meta.docTitle}</title>
</head>
<body>
${inner}
</body>
</html>
`
  writeFileSync(join(DIST, `deck-ru-${key}.html`), full)
  writeFileSync(join(DIST, `deck-ru-${key}.artifact.html`), inner)
  return { key, count: slides.length }
}

const keys = process.argv.slice(2)
const targets = keys.length ? keys
  : (existsSync(CONTENT) ? readdirSync(CONTENT).filter(f=>f.endsWith('.json')).map(f=>f.replace(/\.json$/,'')) : [])

if (!targets.length) { console.error('no content json found in', CONTENT); process.exit(2) }

for (const key of targets) {
  const p = join(CONTENT, `${key}.json`)
  if (!existsSync(p)) { console.error('missing', p); continue }
  const slides = JSON.parse(readFileSync(p, 'utf8'))
  if (!Array.isArray(slides)) { console.error('not an array:', p); continue }
  const r = build(key, slides)
  console.log(`built ${r.key}: ${r.count} slides -> dist/deck-ru-${r.key}.html (+ .artifact.html)`)
}
