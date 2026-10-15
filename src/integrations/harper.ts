import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type { RawLint, SpellEngine, SpellingDialect } from '../core/spelling.js';

const WORKER = join(import.meta.dirname, '..', 'spell', 'worker.ts');

/**
 * Harper (harper.js) in a child process. It starts on first use and stops
 * after `idleMs` without a request: Harper holds about 350 MB, and only
 * ending the process gives that back.
 */
export class HarperEngine implements SpellEngine {
  private child: { proc: Subprocess<'pipe', 'pipe', 'inherit'>; dialect: SpellingDialect; ready: Promise<void> } | null = null;
  private waiting = new Map<number, (lints: RawLint[]) => void>();
  private next = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private timeoutMs = 2_000,
    private idleMs = 30 * 60_000,
    private worker = WORKER,
    /** Starting Harper takes about a second on a small server; Chat waits up to 30. */
    private startMs = 10_000,
  ) {}

  async lint(texts: string[], dialect: SpellingDialect): Promise<RawLint[]> {
    if (this.child && this.child.dialect !== dialect) this.stop();
    const child = (this.child ??= this.start(dialect));
    // Idle time counts from the last answer, never during a request.
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const id = ++this.next;
    const answer = new Promise<RawLint[]>((resolve) => this.waiting.set(id, resolve));
    const within = <T>(promise: Promise<T>, ms: number, what: string) =>
      Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms).unref())]);
    try {
      await within(child.ready, this.startMs, 'not started');
      child.proc.stdin.write(JSON.stringify({ id, texts }) + '\n');
      child.proc.stdin.flush();
      return await within(answer, this.timeoutMs, 'no answer');
    } catch (err) {
      // A child that stopped answering is replaced on the next request.
      this.stop();
      throw err;
    } finally {
      this.waiting.delete(id);
      this.keepAlive();
    }
  }

  /** Ends the child; the next request starts a new one. */
  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.child?.proc.kill();
    this.child = null;
  }

  private keepAlive(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.idleMs);
    this.idle.unref();
  }

  private start(dialect: SpellingDialect) {
    const proc = Bun.spawn([process.execPath, this.worker, dialect], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line === 'ready') resolveReady();
          else if (line.trim()) {
            const { id, lints } = JSON.parse(line) as { id: number; lints: RawLint[] };
            this.waiting.get(id)?.(lints);
          }
        }
      }
    })();
    void proc.exited.then(() => {
      if (this.child?.proc === proc) this.child = null;
    });
    return { proc, dialect, ready };
  }
}
