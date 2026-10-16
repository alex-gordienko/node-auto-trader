export interface ITransition {
  state: number[][];
  action: number;
  reward: number;
  nextState: number[][];
  done: boolean;
}

export class ReplayBuffer {
  private readonly capacity: number;
  private readonly buffer: ITransition[] = [];
  private cursor = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  public push(transition: ITransition): void {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(transition);
      return;
    }

    this.buffer[this.cursor] = transition;
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  public get size(): number {
    return this.buffer.length;
  }

  public sample(batchSize: number): ITransition[] {
    const batch: ITransition[] = [];
    for (let i = 0; i < batchSize; i++) {
      const index = Math.floor(Math.random() * this.buffer.length);
      batch.push(this.buffer[index]);
    }
    return batch;
  }
}
