// Renders the README's screenshots and GIF from the plugin's own drawing code.
//
// A scripted session (reads, edits, a create, a delete, the end of a turn) is
// played through hooks/model.ts exactly as the pane draws it, frame by frame;
// a headless Chromium paints each frame in a monospace font and ffmpeg packs
// the frames into a GIF.
//
//   node scripts/render-media.mjs            # needs Node 23.6+, Playwright, ffmpeg
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node scripts/render-media.mjs
//
// Output lands in docs/media/.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COLOR, FAINT, MUTED,
  buildRows, counted, emptyTurn, headerLine, legendLines, mix, statusLine, summaryLines,
} from '../hooks/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'media')
const FRAMES = join(OUT, '.frames')
const COLUMNS = 46
const HEIGHT = 29 // body rows of the pane
const FPS = 15

// ---------------------------------------------------------------- the scripted session

const PROJECT = [
  'package.json', 'README.md', 'tsconfig.json',
  'src/index.ts',
  'src/auth/session.ts', 'src/auth/types.ts',
  'src/components/Button.tsx', 'src/components/Modal.tsx', 'src/components/Tooltip.tsx', 'src/components/index.ts',
  'src/utils/format.ts', 'src/utils/legacy.ts',
]

/** [start, end, op, path]: one tool call each. */
const CALLS = [
  [400, 1700, 'view', 'src/auth/types.ts'],
  [1800, 3300, 'view', 'src/auth/session.ts'],
  [3400, 5600, 'edit', 'src/auth/session.ts'],
  [5800, 7400, 'create', 'src/components/UserProfile.tsx'],
  [7500, 8900, 'edit', 'src/components/index.ts'],
  [9100, 9800, 'delete', 'src/utils/legacy.ts'],
  [10200, 11300, 'view', 'src/components/Button.tsx'],
]
const TURN_END = 11700
const DURATION = 15500

function treeFor(paths) {
  const entries = new Map()
  for (const p of paths) {
    const parts = p.split('/')
    parts.forEach((_, i) => {
      const sub = parts.slice(0, i + 1).join('/')
      if (!entries.has(sub)) entries.set(sub, { p: sub, d: i < parts.length - 1, m: 1 })
    })
  }
  return [...entries.values()]
}

/** The plugin's state at time `t`, as the hooks would have left it. */
function stateAt(t) {
  let paths = [...PROJECT]
  const activity = {}
  const ghosts = {}
  let turn = { ...emptyTurn(), phase: 'working', at: 0 }
  for (const [start, end, op, path] of CALLS) {
    if (t < start) continue
    if (op === 'create') paths.push(path)
    if (t < end) {
      activity[path] = { op, startedAt: start, running: 1 }
      continue
    }
    if (op === 'delete') {
      paths = paths.filter(p => p !== path)
      delete activity[path]
      ghosts[path] = { d: false, at: end }
      turn = counted(turn, 'delete', path)
    } else {
      activity[path] = { op, startedAt: start, endedAt: end, running: 0 }
      turn = counted(turn, op, path)
    }
  }
  if (t >= TURN_END) turn = { ...turn, phase: 'complete', at: TURN_END }
  return { tree: treeFor(paths), activity, ghosts, turn }
}

// ---------------------------------------------------------------- the pane, as register.tsx lays it out

const folders = new Map()

function rule(label) {
  return [{ t: '── ', c: FAINT }, { t: label, c: FAINT, b: true }, { t: ' ' + '─'.repeat(Math.max(0, COLUMNS - label.length - 4)), c: FAINT }]
}

function smoothIn(t) {
  const k = Math.min(1, Math.max(0, t))
  return k * k * (3 - 2 * k)
}

function paneAt(t) {
  const now = t + 100_000 // any epoch works; keeps every age positive
  const shift = a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, {
    ...v,
    ...('startedAt' in v ? { startedAt: v.startedAt + 100_000 } : {}),
    ...(v.endedAt !== undefined ? { endedAt: v.endedAt + 100_000 } : {}),
    ...('at' in v ? { at: v.at + 100_000 } : {}),
  }]))
  const s = stateAt(t)
  const activity = shift(s.activity)
  const ghosts = shift(s.ghosts)
  const turn = { ...s.turn, at: s.turn.at + 100_000 }
  const rows = buildRows({ tree: s.tree, activity, ghosts, now, columns: COLUMNS, folders })
  const isWorking = Object.values(activity).some(a => a.running > 0) || turn.phase === 'working'
  const summary = summaryLines(turn, now, COLUMNS - 4)
  const legend = legendLines(COLUMNS)

  const lines = [
    headerLine(now, isWorking, 'my-app'),
    statusLine(activity, turn, now, s.tree.filter(e => !e.d).length, COLUMNS),
    rule('tree'),
    ...rows.map(r => r.segs),
  ]
  if (summary.length > 0) {
    const age = now - turn.at
    const fade = age > 18_500 ? Math.max(0, (20_000 - age) / 1500) : 1
    const border = mix(FAINT, COLOR.create, smoothIn(age / 500) * 0.8 * fade)
    const inner = COLUMNS - 4
    lines.push([{ t: '╭' + '─'.repeat(COLUMNS - 2) + '╮', c: border }])
    for (const segs of summary) {
      const used = segs.reduce((w, x) => w + [...x.t].length, 0)
      lines.push([{ t: '│ ', c: border }, ...segs, { t: ' '.repeat(Math.max(0, inner - used)) + ' │', c: border }])
    }
    lines.push([{ t: '╰' + '─'.repeat(COLUMNS - 2) + '╯', c: border }])
  }
  while (lines.length < HEIGHT - 1 - legend.length) lines.push([])
  lines.push(rule('legend'), ...legend)
  return lines
}

// ---------------------------------------------------------------- painting

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function html(lines) {
  const body = lines.map(segs => `<div class="l">${segs.map(s => {
    const style = [
      s.c ? `color:${s.c}` : '',
      s.bg ? `background:${s.bg}` : '',
      s.b ? 'font-weight:700' : '',
      s.s ? 'text-decoration:line-through' : '',
      s.dim ? 'opacity:.55' : '',
    ].filter(Boolean).join(';')
    return `<span style="${style}">${escape(s.t)}</span>`
  }).join('')}&#8203;</div>`).join('')
  return body
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#010409}
  #win{display:inline-block;margin:22px;border-radius:10px;overflow:hidden;background:#0d1117;
       box-shadow:0 0 0 1px #30363d,0 16px 40px rgba(0,0,0,.55)}
  #bar{height:30px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#161b22;border-bottom:1px solid #21262d}
  #bar i{width:12px;height:12px;border-radius:50%;display:block}
  #bar b{flex:1;text-align:center;font:500 12px 'JetBrainsMono Nerd Font',monospace;color:#6e7681;margin-right:52px}
  #pane{width:${COLUMNS}ch;height:${HEIGHT * 20}px;padding:12px 16px 14px;overflow:hidden;font:15px/20px 'JetBrainsMono Nerd Font','JetBrains Mono',monospace;color:#c9d1d9;white-space:pre}
  .l{height:20px}
  .l span{display:inline-block;height:20px;vertical-align:top;overflow:hidden}
</style></head><body><div id="win"><div id="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b>claude · work-map</b></div><div id="pane"></div></div></body></html>`

async function main() {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright')
  rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.setContent(PAGE)
  await page.evaluate(() => document.fonts.ready)
  const win = page.locator('#win')
  const show = lines => page.evaluate(h => { document.getElementById('pane').innerHTML = h }, html(lines))

  // The GIF: every frame of the session, in order (the folder memory needs it).
  const total = Math.round((DURATION / 1000) * FPS)
  const stillsAt = { read: 2700, edit: 4600, create: 6150, delete: 9650, complete: 13400 }
  const stills = {}
  for (let i = 0; i < total; i++) {
    const t = (i * 1000) / FPS
    const lines = paneAt(t)
    for (const [name, at] of Object.entries(stillsAt)) {
      if (stills[name] === undefined && t >= at) stills[name] = lines
    }
    await show(lines)
    await win.screenshot({ path: join(FRAMES, `f${String(i).padStart(4, '0')}.png`), omitBackground: false })
  }

  // Stills at twice the resolution, for sharp screenshots.
  const sharp = await browser.newPage({ deviceScaleFactor: 2 })
  await sharp.setContent(PAGE)
  await sharp.evaluate(() => document.fonts.ready)
  for (const [name, lines] of Object.entries(stills)) {
    await sharp.evaluate(h => { document.getElementById('pane').innerHTML = h }, html(lines))
    await sharp.locator('#win').screenshot({ path: join(OUT, `${name}.png`) })
  }
  await browser.close()

  const gif = join(OUT, 'demo.gif')
  const palette = join(FRAMES, 'palette.png')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, 'f%04d.png'),
    '-vf', 'palettegen=max_colors=256:stats_mode=full', palette])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, 'f%04d.png'), '-i', palette,
    '-lavfi', 'paletteuse=dither=none:diff_mode=rectangle', '-loop', '0', gif])
  rmSync(FRAMES, { recursive: true, force: true })
  console.log(`wrote ${gif} and ${Object.keys(stills).length} stills`)
}

await main()
