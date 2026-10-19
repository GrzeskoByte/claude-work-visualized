import { expect, mock, test } from 'claude-code/testing'

import {
  buildRows, classifyBash, diffTrees, emptyTurn, focusOf, relPath, statusLine, summaryLines, T, thoughtRows, thoughtView, typeTo,
  withThought, wrapWords,
} from './model'
import type { FolderMemory } from './model'

const ROOT = '/proj'
const FILES: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '': [
    { name: 'src', kind: 'dir' },
    { name: 'package.json', kind: 'file' },
    { name: 'node_modules', kind: 'dir' },
  ],
  src: [
    { name: 'auth', kind: 'dir' },
    { name: 'index.ts', kind: 'file' },
  ],
  'src/auth': [
    { name: 'session.ts', kind: 'file' },
    { name: 'types.ts', kind: 'file' },
  ],
}

const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')

test('paths are made relative and ignored folders dropped', async () => {
  expect(relPath(ROOT, '/proj/src/a.ts')).toBe('src/a.ts')
  expect(relPath(ROOT, '/proj/./src/../b.ts')).toBe('b.ts')
  expect(relPath(ROOT, '/elsewhere/a.ts')).toBe(undefined)
  expect(relPath(ROOT, '/proj/node_modules/x/index.js')).toBe(undefined)
})

test('shell commands are read for views, edits, creates and deletes', async () => {
  expect(classifyBash('cat src/a.ts | grep foo src/b.ts')).toEqual([
    { op: 'view', path: 'src/a.ts' },
    { op: 'view', path: 'src/b.ts' },
  ])
  expect(classifyBash('rm -rf dist old.ts && touch new.ts')).toEqual([
    { op: 'delete', path: 'dist' },
    { op: 'delete', path: 'old.ts' },
    { op: 'create', path: 'new.ts' },
  ])
  expect(classifyBash("sed -i 's/a/b/' src/x.ts")).toEqual([{ op: 'edit', path: 'src/x.ts' }])
  expect(classifyBash('echo hi > notes.md')).toEqual([{ op: 'edit', path: 'notes.md' }])
  expect(classifyBash('git mv a.ts b.ts')).toEqual([
    { op: 'delete', path: 'a.ts' },
    { op: 'create', path: 'b.ts' },
  ])
})

test('a scan diff finds created, edited and deleted paths, one ghost per deleted folder', async () => {
  const before = [
    { p: 'a.ts', d: false, m: 1 },
    { p: 'lib', d: true, m: 0 },
    { p: 'lib/x.ts', d: false, m: 1 },
  ]
  const after = [
    { p: 'a.ts', d: false, m: 2 },
    { p: 'b.ts', d: false, m: 1 },
  ]
  const diff = diffTrees(before, after)
  expect(diff.created.map(t => t.p)).toEqual(['b.ts'])
  expect(diff.edited).toEqual(['a.ts'])
  expect(diff.deleted.map(t => t.p)).toEqual(['lib'])
})

test('the running file is the focus, with the strongest marker and its folders lit', async () => {
  const tree = [
    { p: 'src', d: true, m: 0 },
    { p: 'src/a.ts', d: false, m: 1 },
    { p: 'src/b.ts', d: false, m: 1 },
  ]
  const activity = {
    'src/a.ts': { op: 'view' as const, startedAt: 0, endedAt: 500, running: 0 },
    'src/b.ts': { op: 'edit' as const, startedAt: 900, running: 1 },
  }
  expect(focusOf(activity)).toBe('src/b.ts')
  const folders: FolderMemory = new Map()
  const rows = buildRows({ tree, activity, ghosts: {}, now: 1000, columns: 40, folders })
  expect(rows.map(r => r.path)).toEqual(['src', 'src/a.ts', 'src/b.ts'])
  expect(text(rows[2]?.segs ?? [])).toContain('◂ editing')
  expect(text(rows[2]?.segs ?? [])).toContain('└╴')
  expect(text(rows[0]?.segs ?? [])).toContain('●')
  expect(text(rows[1]?.segs ?? [])).toContain('✓')
})

test('a deleted file shakes, fades, then leaves the tree', async () => {
  const tree = [{ p: 'keep.ts', d: false, m: 1 }]
  const ghosts = { 'gone.ts': { d: false, at: 0 } }
  const at = (now: number) => buildRows({ tree, activity: {}, ghosts, now, columns: 40, folders: new Map() })
  expect(at(100).map(r => r.path)).toEqual(['gone.ts', 'keep.ts'])
  expect(at(100)[0]?.segs.some(s => s.bg !== undefined)).toBe(true)
  expect(at(1500)[0]?.segs.some(s => s.s === true)).toBe(true)
  expect(at(T.ghostGone + 1).map(r => r.path)).toEqual(['keep.ts'])
})

test('every glyph in a row is one cell, so columns line up at any frame', async () => {
  const tree = [
    { p: 'src', d: true, m: 0 },
    { p: 'src/a.ts', d: false, m: 1 },
  ]
  for (const op of ['view', 'edit', 'create', 'delete'] as const) {
    for (let now = 0; now < 3000; now += 37) {
      const rows = buildRows({ tree, activity: { 'src/a.ts': { op, startedAt: 0, running: 1 } }, ghosts: {}, now, columns: 40, folders: new Map() })
      for (const r of rows) for (const s of r.segs) expect(/\p{Extended_Pictographic}/u.test(s.t) && s.t !== '✓' && s.t !== '✗').toBe(false)
      expect(text(rows[1]?.segs ?? []).length).toBeLessThanOrEqual(40)
    }
  }
})

test('the prompt line never runs past the pane, however long the path', async () => {
  const activity = { 'src/components/some/deeply/nested/UserProfileSettings.tsx': { op: 'create' as const, startedAt: 0, running: 1 } }
  for (const columns of [24, 40, 46, 80]) {
    expect(text(statusLine(activity, emptyTurn(), 1234, 10, columns)).length).toBeLessThanOrEqual(columns)
  }
})

test('the completion card counts up and then goes', async () => {
  const turn = {
    phase: 'complete' as const,
    at: 0,
    counts: { view: ['a', 'b', 'c'], edit: ['a'], create: [], delete: [] },
  }
  expect(text(summaryLines(turn, 2000).flat())).toContain('viewed    3')
  expect(text(summaryLines(turn, 2000).flat())).toContain('edited    1')
  expect(summaryLines(turn, T.summary + 1)).toEqual([])
})

test('thinking is kept as one line, a new block starting over', async () => {
  const a = withThought(null, 'k1', '  Let me\n\nlook', 0)
  expect(a.text).toBe('Let me look')
  const b = withThought(a, 'k1', ' at  this.', 10)
  expect(b.text).toBe('Let me look at this.')
  expect(withThought(b, 'k2', 'Next.', 20)).toEqual({ key: 'k2', text: 'Next.', dropped: 0, at: 20 })
})

test('the typewriter keeps a reading pace and speeds up only when far behind', async () => {
  expect(typeTo(0, 100, 1000)).toBe(35)
  expect(typeTo(0, 4000, 1000)).toBeGreaterThan(300)
  expect(typeTo(5, 5, 33)).toBe(5)
  expect(typeTo(0, 300, 1000, 'late')).toBe(105)
})

test('thinking wraps, shows a share of the pane, scrolls, and fades a while after the turn', async () => {
  expect(wrapWords('one two three', 7)).toEqual(['one two', 'three'])
  expect(wrapWords('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(thoughtRows(10)).toBe(4)
  expect(thoughtRows(30)).toBe(9)
  expect(thoughtRows(100)).toBe(12)
  const working = { ...emptyTurn(), phase: 'working' as const }
  const long = withThought(null, 'k', 'word '.repeat(60), 0)
  const view = (top?: number) => thoughtView({ thought: long, typed: 10_000, now: 100, turn: working, columns: 30, rows: 4, top })
  expect(view().lines.length).toBe(4)
  expect(view().below).toBe(0)
  expect(view().above).toBeGreaterThan(0)
  for (const l of view().lines) expect(text(l).length).toBeLessThanOrEqual(30)
  expect(text(view().lines[3] ?? [])).toContain('▏')
  expect(view(0).above).toBe(0)
  expect(view(0).below).toBeGreaterThan(0)
  expect(view(999).below).toBe(0)
  const half = thoughtView({ thought: withThought(null, 'k', 'Reading the config', 0), typed: 7, now: 100, turn: working, columns: 40, rows: 4 })
  expect(text(half.lines.flat())).toBe(' Reading▏')
  const done = { ...withThought(null, 'k', 'Done.', 0), endedAt: 1000 }
  const ended: ReturnType<typeof emptyTurn> = { ...emptyTurn(), phase: 'complete', at: 2000 }
  const at = (now: number, turn = ended) => thoughtView({ thought: done, typed: 5, now, turn, columns: 40, rows: 4 }).lines
  expect(text(at(2000).flat())).toBe(' Done.')
  expect(at(60_000, working).length).toBe(1)
  expect(at(2000 + T.thoughtLinger - 1).length).toBe(1)
  expect(at(2000 + T.thoughtLinger + T.thoughtFade + 1)).toEqual([])
  expect(at(2000 + T.thoughtLinger + T.thoughtFade + 1).length).toBe(0)
  const waiting = { ...done, waitingSince: 0 }
  const held = thoughtView({ thought: waiting, typed: 0, now: 4200, turn: working, columns: 40, rows: 4 })
  expect(text(held.lines.flat())).toBe(' • • • • •')
  expect(held.waited).toBe(4)
  expect(thoughtView({ thought: withThought(null, 'k', '', 0), typed: 0, now: 100, turn: working, columns: 40, rows: 4 }).lines).toEqual([])
})

test('thinking streamed in a step types itself into the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'Checking how the\nconfig is loaded' }
    yield { kind: 'text', index: 1, text: 'Done.' }
    return { turnId: 't1', index: 0, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  const chunks: unknown[] = []
  let step = await stream.next()
  for (; step.done !== true; step = await stream.next()) chunks.push(step.value)
  expect(chunks.length).toBe(2)
  expect(step.value.answer).toBe('Done.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    await clock.advance(2000)
    await ui.unmount()
    const again = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    const shown = (await again.findAll({ type: 'Text' })).map(x => x.text).join('')
    expect(shown).toContain('thinking')
    expect(shown).toContain('Checking how the config is loaded')
    await again.unmount()
  }
})

test('a Read shows in the pane as Claude viewing that file', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) => {
    const rel = !e.path || e.path === '' || e.path === '.' || e.path === ROOT ? '' : e.path.replace(/^\/proj\//, '')
    return { value: (FILES[rel] ?? []).map(f => ({ ...f, size: 1, mtimeMs: f.kind === 'file' ? 1 : 0, isLink: false })) }
  })
  let release = () => {}
  let reached = () => {}
  const arrived = new Promise<void>(r => (reached = r))
  on('tool.call', { tool: 'Read' }, () =>
    new Promise(resolve => {
      reached()
      release = () => resolve({ result: { type: 'text', file: { filePath: '/proj/src/auth/session.ts', content: '', numLines: 0, startLine: 1, totalLines: 0 } } } as never)
    }),
  )
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  const off = await $.command.run({ command: 'watch', args: '' } as never)
  expect(JSON.stringify(off)).toContain('is off')
  const back = await $.command.run({ command: 'watch', args: '' } as never)
  expect(JSON.stringify(back)).toContain('is on')

  const reading = $.tool.call({ tool: 'Read', file_path: '/proj/src/auth/session.ts' } as never)
  await arrived

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
    expect(shown).toContain('work-map ~/proj')
    expect(shown).toContain('reading src/auth/session.ts')
    expect(shown).toContain('◂ reading')
    expect(shown).not.toContain('node_modules')
    expect(shown).toContain('✗ delete')
    await ui.unmount()
  }
  release()
  await reading
})

test('the wheel over the thinking section scrolls back through the thought', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'First idea. ' + 'more '.repeat(150) }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await $.turn.start({ turnId: 't1', source: 'prompt' } as never).catch(() => undefined)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  for (let step = await stream.next(); step.done !== true; step = await stream.next()) {}

  const mount = () => $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const shownBy = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  const ui = await mount()
  await clock.advance(30_000)
  await ui.unmount()
  const typed = await mount()
  expect(await shownBy(typed)).toContain('── ↑')
  expect(await shownBy(typed)).not.toContain('First idea.')
  await typed.unmount()

  await $.ui.scroll({ component: 'Pane', requestId: 'work-map', by: -50, offset: 0, bodyRows: 30, contentRows: 30, origin: { kind: 'person' }, pointer: { column: 5, row: 4 } } as never)
  const back = await mount()
  expect(await shownBy(back)).toContain('First idea.')
  expect(await shownBy(back)).toContain('↓')
  await back.unmount()
})

test('a wave of dots holds the place until the thinking text comes, and a step without thinking keeps the last thought', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('turn.step', async function* (_$, e) {
    if (e.index === 0) {
      await clock.sleep(3000)
      yield { kind: 'thinking', index: 0, text: 'Late summary.' }
    }
    yield { kind: 'text', index: 1, text: 'Done.' }
    return { turnId: 't1', index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  // The pane types only while it is drawn, so it stays mounted while the clock moves.
  const shown = async (ms = 0) => {
    const mount = () => $.ui.mount({
      plugin: 'work-visualized',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    const ui = await mount()
    await clock.advance(ms)
    await ui.unmount()
    const again = await mount()
    const out = (await again.findAll({ type: 'Text' })).map(x => x.text).join('')
    await again.unmount()
    return out
  }
  const drain = async (s: ReturnType<typeof $.turn.step>) => {
    for (let step = await s.next(); step.done !== true; step = await s.next()) {}
  }

  const first = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  const done = drain(first)
  const waiting = await shown(1500)
  expect(waiting).toContain('thinking 1s')
  expect(waiting.split('thinking').length - 1).toBe(1)
  await clock.advance(2000)
  await done
  expect(await shown(5000)).toContain('Late summary.')

  await drain($.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 2 }))
  const after = await shown()
  expect(after).toContain('Late summary.')
  expect(after).not.toContain('• • •')
})
