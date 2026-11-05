import { StringDecoder } from 'node:string_decoder';

/** Incrementally decode Pi's LF-delimited JSON protocol, including split UTF-8. */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  push(chunk: Buffer): unknown[] {
    this.pending += this.decoder.write(chunk);
    const records: unknown[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      records.push(JSON.parse(line));
    }
    return records;
  }
}
