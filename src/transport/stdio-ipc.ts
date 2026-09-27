import type { ChildProcess } from 'node:child_process'
import { fork } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { WorkerMessageOut } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const STDOUT_BUF_CAP = 1024 * 1024

export interface ManagedWorker {
  id: string
  workerId: string
  child: ChildProcess
  send(msg: { type: string; [k: string]: unknown }): void
  stop(timeoutMs?: number): Promise<void>
  on(event: 'message', handler: (msg: WorkerMessageOut) => void): void
  on(event: 'exit', handler: (code: number | null) => void): void
}

export function spawnWorker(entry: string, env: Record<string, string> = {}): ManagedWorker {
  const id = randomUUID().slice(0, 8)
  const child = fork(entry, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...env }, // AUTOPW_WORKER_ID comes from caller via `env` (no override)
    serialization: 'advanced',
  })

  const messageListeners: Array<(msg: WorkerMessageOut) => void> = []
  const exitListeners: Array<(code: number | null) => void> = []
  let outBuffer = ''
  let dropped = 0
  child.stdout?.on('data', (chunk: Buffer) => {
    outBuffer += chunk.toString('utf8')
    let idx
    while ((idx = outBuffer.indexOf('\n')) !== -1) {
      const line = outBuffer.slice(0, idx).trim()
      outBuffer = outBuffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as WorkerMessageOut
        messageListeners.forEach((h) => h(msg))
      } catch {
        // ignore malformed lines (stdout may interleave with playwright logs)
      }
    }
    if (outBuffer.length > STDOUT_BUF_CAP) {
      dropped += outBuffer.length
      outBuffer = ''
      if (dropped % (256 * 1024) < STDOUT_BUF_CAP) {
        process.stderr.write(`[wp-worker ${id}] stdout buffer overflow: dropped ${dropped} bytes\n`)
      }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[wp-worker ${id}] ${chunk.toString('utf8')}`)
  })
  child.on('error', (err) => {
    process.stderr.write(`[wp-worker ${id}] child error: ${err.message}\n`)
  })
  child.on('exit', (code) => {
    if (outBuffer.length) {
      try {
        const tail = JSON.parse(outBuffer) as WorkerMessageOut
        messageListeners.forEach((h) => h(tail))
      } catch {}
    }
    if (messageListeners.length === 0) {
      process.stderr.write(`[wp-worker ${id}] exited code=${code} (no messages received)\n`)
    } else {
      process.stderr.write(`[wp-worker ${id}] exited code=${code}\n`)
    }
    exitListeners.forEach((h) => h(code))
  })

  return {
    id,
    child,
    workerId: (env.AUTOPW_WORKER_ID ?? id) as string,
    send(msg) {
      try {
        const ok = child.send(msg, (err: Error | null) => {
          if (err) process.stderr.write(`[wp-worker ${id}] send cb error: ${err.message}\n`)
        })
        if (!ok) process.stderr.write(`[wp-worker ${id}] channel not ready, message dropped\n`)
      } catch (e: any) {
        process.stderr.write(`[wp-worker ${id}] send threw: ${e?.message ?? String(e)}\n`)
      }
    },
    async stop(timeoutMs = 5_000) {
      if (child.exitCode !== null) return
      try {
        child.send({ type: 'stop' })
      } catch {}
      await new Promise<void>((resolveP) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          resolveP()
        }, timeoutMs)
        child.once('exit', () => {
          clearTimeout(t)
          resolveP()
        })
      })
    },
    on(event, handler) {
      if (event === 'message') messageListeners.push(handler as any)
      else if (event === 'exit') exitListeners.push(handler as any)
    },
  }
}

