// src/serial-queue.ts — 串行执行队列（通用工具）
// 联机场景：玩家消息与房主消息统一入队、一次只处理一条（保证顺序、避免并发写库）。
// 曾内嵌在 electron/main.ts（不可单测）；抽出后行为不变且可测。
export class SerialQueue<T, R = unknown> {
  private queue: { item: T; resolve: (r: R) => void; reject: (e: unknown) => void }[] = [];
  private draining = false;
  private readonly handler: (item: T) => Promise<R>;

  constructor(handler: (item: T) => Promise<R>) {
    this.handler = handler;
  }

  // 入队并返回处理结果 Promise（调用方 await 得到本次处理结果，或等队列轮到时 reject）
  enqueue(item: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const { item, resolve, reject } = this.queue.shift()!;
        try {
          resolve(await this.handler(item));
        } catch (e) {
          reject(e);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // 清空未决项（如关房）：reject 所有排队任务，调用方可见"已关闭"错误
  clear(reason: Error): void {
    for (const p of this.queue) p.reject(reason);
    this.queue = [];
  }

  get pending(): number {
    return this.queue.length;
  }
}
