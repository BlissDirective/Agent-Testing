// Splits streamed LLM text into speakable chunks for TTS. Sending whole
// sentences keeps prosody natural while starting audio long before the reply
// is finished.

const SENTENCE_END = /[.!?]["')\]]?\s/;
const CLAUSE_END = /[,;:]\s/;
const FLUSH_TAG = "<flush/>";

export class SentenceChunker {
  private buffer = "";

  constructor(
    /** Split at a comma etc. once the buffer is at least this long. */
    private readonly softLimit = 120,
    /** Split at any space once the buffer is at least this long. */
    private readonly hardLimit = 250,
  ) {}

  /** Add streamed text; returns any chunks that are ready to speak. */
  push(text: string): string[] {
    this.buffer += text;
    const chunks: string[] = [];

    for (;;) {
      const flushAt = this.buffer.indexOf(FLUSH_TAG);
      if (flushAt !== -1) {
        this.emit(chunks, this.buffer.slice(0, flushAt));
        this.buffer = this.buffer.slice(flushAt + FLUSH_TAG.length);
        continue;
      }
      const end = this.findBreak();
      if (end === -1) break;
      this.emit(chunks, this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
    return chunks;
  }

  /** Return whatever is left at the end of the reply. */
  flush(): string[] {
    const chunks: string[] = [];
    this.emit(chunks, this.buffer);
    this.buffer = "";
    return chunks;
  }

  private findBreak(): number {
    const sentence = SENTENCE_END.exec(this.buffer);
    if (sentence) return sentence.index + sentence[0].length;
    if (this.buffer.length >= this.softLimit) {
      const clause = CLAUSE_END.exec(this.buffer);
      if (clause) return clause.index + clause[0].length;
    }
    if (this.buffer.length >= this.hardLimit) {
      const space = this.buffer.lastIndexOf(" ");
      if (space > 0) return space + 1;
    }
    return -1;
  }

  private emit(chunks: string[], text: string): void {
    const trimmed = text.trim();
    if (trimmed) chunks.push(trimmed);
  }
}
