export type TurnJob<T> = {
  readonly key: string;
  readonly run: (signal: AbortSignal) => Promise<T>;
};

export type QueueOptions = {
  readonly timeoutMs: number;
  readonly onDepthChange?: (depth: number) => void;
};

export class TurnTimeoutError extends Error {
  constructor(ms: number) {
    super(`turn exceeded its ${ms}ms watchdog`);
    this.name = "TurnTimeoutError";
  }
}

export class TurnAbortedError extends Error {
  constructor() {
    super("turn aborted");
    this.name = "TurnAbortedError";
  }
}

type Pending = {
  readonly key: string;
  readonly start: () => void;
  readonly cancel: (reason: Error) => void;
};

export type TurnQueue = {
  readonly submit: <T>(job: TurnJob<T>) => Promise<T>;
  readonly abort: (key: string) => boolean;
  readonly abortAll: () => number;
  readonly depth: () => number;
  readonly drain: () => Promise<void>;
};

export const createTurnQueue = (options: QueueOptions): TurnQueue => {
  const waiting: Pending[] = [];
  const active = new Map<string, AbortController>();
  let running = false;
  let idle: Promise<void> = Promise.resolve();
  let releaseIdle: () => void = () => {};

  const depth = () => waiting.length + active.size;
  const announce = () => options.onDepthChange?.(depth());

  const pump = () => {
    if (running) return;
    const next = waiting.shift();
    if (next === undefined) {
      releaseIdle();
      return;
    }
    running = true;
    next.start();
  };

  const submit = <T>(job: TurnJob<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (depth() === 0) {
        idle = new Promise<void>((r) => {
          releaseIdle = r;
        });
      }

      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;

      const settle = (fn: () => void) => {
        if (timer !== undefined) clearTimeout(timer);
        active.delete(job.key);
        running = false;
        fn();
        announce();
        pump();
      };

      waiting.push({
        key: job.key,
        cancel: (reason) => {
          const index = waiting.findIndex((p) => p.key === job.key);
          if (index >= 0) waiting.splice(index, 1);
          reject(reason);
          announce();
        },
        start: () => {
          active.set(job.key, controller);
          timer = setTimeout(() => {
            controller.abort(new TurnTimeoutError(options.timeoutMs));
          }, options.timeoutMs);

          job
            .run(controller.signal)
            .then((value) => settle(() => resolve(value)))
            .catch((error: unknown) => {
              const reason = controller.signal.aborted
                ? ((controller.signal.reason as Error | undefined) ?? new TurnAbortedError())
                : error;
              settle(() => reject(reason));
            });
        },
      });

      announce();
      pump();
    });

  return {
    submit,
    abort: (key) => {
      const controller = active.get(key);
      if (controller !== undefined) {
        controller.abort(new TurnAbortedError());
        return true;
      }
      const pending = waiting.find((p) => p.key === key);
      if (pending === undefined) return false;
      pending.cancel(new TurnAbortedError());
      return true;
    },
    abortAll: () => {
      const queued = [...waiting];
      waiting.length = 0;
      for (const p of queued) p.cancel(new TurnAbortedError());
      let count = queued.length;
      for (const controller of active.values()) {
        controller.abort(new TurnAbortedError());
        count += 1;
      }
      announce();
      return count;
    },
    depth,
    drain: () => idle,
  };
};
