/** A durable encrypted checkpoint owner supplies this session; provider adapters never create it. */
export interface AccountOperation {
  readonly id: string;
  readonly recovery: unknown;
  readonly result: unknown;
  readonly completed: boolean;
  readonly signal: AbortSignal;
  checkpoint(this: void, value: unknown): Promise<void>;
  complete(this: void, value: unknown): Promise<void>;
}
