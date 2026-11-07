/**
 * Runs `step` again and again until `stop()`: the loop behind every background job (outbox relay,
 * queue consumers). `step` returns how many milliseconds to wait before the next run (0 = go on
 * at once, for a batch that was full). A step that throws is reported to `onError`, then the loop
 * waits `errorDelayMs`, so a broken dependency is retried slowly instead of in a hot loop.
 *
 * The wait is cancelled by `stop()` and its timer is unref'd, so an idle loop never keeps a
 * process or a test run alive. `stop()` resolves after the step in flight has finished.
 */
export class PollingLoop {
  private stopped = true;
  private running: Promise<void> | undefined;
  private cancelWait: (() => void) | undefined;

  constructor(
    private readonly step: () => Promise<number>,
    private readonly onError: (error: unknown) => void,
    private readonly errorDelayMs = 5000,
  ) {}

  get isRunning(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelWait?.();
    await this.running;
    this.running = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let delay: number;
      try {
        delay = await this.step();
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          // Reporting must never end the loop.
        }
        delay = this.errorDelayMs;
      }
      if (delay > 0 && !this.stopped) await this.wait(delay);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      timer.unref();
      this.cancelWait = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
