# Development

## Commands

Run these from the plugin folder:

```sh
claude plugin validate .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .       # runs hooks/*.test.tsx against the engine
npx -p typescript@5 tsc -p .   # type-check (tsconfig.json extends the engine-written types)
```

`.claude-plugin/types/` and `tsconfig.json` are written by Claude Code each time it loads the mod.
Don't edit them; they come back on the next load.

## Hot reload

Inside a session that loads this folder through hot reloading, `--plugin-dir` or
`CLAUDE_CODE_PLUGIN_DIRS`, saving any file reloads the mod. When Claude makes the edit, the reload
happens once its turn ends. A reload runs `register` again and fires `session.start` again:

- what's in `$.state` and `$.store` stays (the tree, the activity, the watching flag)
- module variables start over (folder memory, scroll position, the frame timer)

If a hook fails or the module doesn't load, the transcript shows a dim line naming the event and
the reason.

## Tests

`hooks/work.test.tsx` covers:

- making paths relative and leaving out ignored folders
- reading shell commands (`classifyBash`)
- scan diffs, with one ghost per deleted folder
- the current file's row: the `◂` label, lit tree guides, parent-folder dots
- deletion timing: highlight, then dissolve, then removed
- one-cell glyphs only, and rows never wider than the pane, sampled across every operation's
  animation
- the completion card counting up and disappearing
- end to end: a `Read` running against mocked `fs.list` and `session.cwd` appears in the pane on
  both the terminal and the desktop, and `/watch` switches off and on

Calls that reach the engine beneath the plugin have to be answered by the test's own `on(...)`,
with results wrapped as `{ value }` (for example `on('fs.list', () => ({ value: [...] }))`).

## Changing things

| To change | Edit |
| --- | --- |
| Timings (fade, deletion, card) | `T` in `hooks/model.ts` |
| Colours, glyphs, labels | `COLOR`, `HOT`, `TINT`, `ICON`, `LABEL`, `VERB` in `hooks/model.ts` |
| Ignored folders | `IGNORED` in `hooks/model.ts` |
| Frame rate, rescan interval, scan limits | `FRAME_MS`, `POLL_MS`, `MAX_ENTRIES`, `MAX_DEPTH` in `hooks/register.tsx` |
| Which tools count as which operation | `targetsOf()` in `hooks/register.tsx` |
| Shell command reading | `classifyBash()` in `hooks/model.ts` |
| Pane layout | the `ui.render` hook in `hooks/register.tsx` |

Keep every glyph a single cell. Emoji and characters that need a variation selector are drawn two
cells wide by some terminals, which misaligns the tree; a test samples rows to catch this.
