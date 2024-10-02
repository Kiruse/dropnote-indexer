import fs from 'fs/promises';
import { type IDropnoteKVStorage } from '../types';
import { debounce } from '../utils';

export class JsonStorage implements IDropnoteKVStorage {
  #strings: Record<string, string> | undefined;
  #binary: Record<string, Uint8Array> | undefined;

  constructor(
    private readonly path: string
  ) {}

  async #init() {
    if (this.#strings && this.#binary) return;
    try {
      const jsons = await fs.readFile(this.path, 'utf-8');
      const json = JSON.parse(jsons);
      this.#strings = json.strings;
      this.#binary = json.binary;
    } catch {
      this.#strings = {};
      this.#binary = {};
    }
  }

  #save = debounce(async () => {
    if (!this.#strings || !this.#binary) return;
    await fs.writeFile(this.path, JSON.stringify({ strings: this.#strings, binary: this.#binary }));
  }, 1000);

  async get(key: string): Promise<string | Uint8Array | undefined> {
    if (!this.#strings || !this.#binary) await this.#init();
    return this.#strings![key] ?? this.#binary![key];
  }

  async set(key: string, value: string | Uint8Array): Promise<void> {
    if (!this.#strings || !this.#binary) await this.#init();
    if (typeof value === 'string') {
      this.#strings![key] = value;
    } else {
      this.#binary![key] = value;
    }
    this.#save();
  }

  async delete(key: string): Promise<void> {
    if (!this.#strings || !this.#binary) await this.#init();
    delete this.#strings![key];
    delete this.#binary![key];
  }

  async keys(): Promise<string[]> {
    if (!this.#strings || !this.#binary) await this.#init();
    const result = new Set<string>();
    for (const key of Object.keys(this.#strings!)) result.add(key);
    for (const key of Object.keys(this.#binary!)) result.add(key);
    return Array.from(result);
  }
}
