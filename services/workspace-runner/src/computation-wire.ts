/** Stream ordinary output without retaining a whole line; only framed packets have a size ceiling. */
export class ComputationWire {
  #buffer = '';
  constructor(
    private readonly token: string,
    private readonly output: (value: string) => void,
    private readonly packet: (value: string) => void
  ) {}
  push(chunk: string): void {
    this.#buffer += chunk;
    while (this.#buffer) {
      const marker = this.#buffer.indexOf(this.token);
      if (marker < 0) {
        let pending = Math.min(this.token.length - 1, this.#buffer.length);
        while (pending && !this.token.startsWith(this.#buffer.slice(-pending))) pending--;
        this.output(this.#buffer.slice(0, this.#buffer.length - pending));
        this.#buffer = pending ? this.#buffer.slice(-pending) : '';
        return;
      }
      if (marker > 0) {
        this.output(this.#buffer.slice(0, marker));
        this.#buffer = this.#buffer.slice(marker);
      }
      const newline = this.#buffer.indexOf('\n');
      const end = newline < 0 ? this.#buffer.length : newline;
      // Four two-MiB plot payloads expand to under twelve MiB with base64 and receipt metadata.
      if (Buffer.byteLength(this.#buffer.slice(0, end)) > 12 * 1024 * 1024)
        throw Error('Computation protocol packet exceeded limit');
      if (newline < 0) return;
      const packet = this.#buffer.slice(this.token.length, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.packet(packet);
    }
  }
}
