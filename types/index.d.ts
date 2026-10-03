export type Op = 'view' | 'edit' | 'create' | 'delete'

/** One path of the scanned project, relative to the session's directory. */
export type TreeEntry = { p: string; d: boolean; m: number }

/** What Claude last did to a path, and when (ms since the epoch). */
export type Activity = {
  op: Op
  startedAt: number
  /** Absent while the operation runs. */
  endedAt?: number
  /** Tool calls currently running on the path. */
  running: number
}

/** A deleted path kept on screen while its exit plays. */
export type Ghost = { d: boolean; at: number }

export type TurnInfo = {
  phase: 'idle' | 'working' | 'complete'
  at: number
  counts: Record<Op, string[]>
}

declare module 'claude-code' {
  interface PluginState {
    'work-visualized': {
      tree: TreeEntry[]
      activity: Record<string, Activity>
      ghosts: Record<string, Ghost>
      turn: TurnInfo
      watching: boolean
    }
  }
}
