import { fromBase64, toBase64 } from '@apophis-sdk/core/utils.js';
import { type IDropnoteKVStorage } from '../types.js';

declare global {
  var localStorage: IStorage;
}

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  clear(): void;
  length: number;
}

/** A KV storage implementation using `localStorage` - accordingly, this is only available in the browser. */
export class LocalStorage implements IDropnoteKVStorage {
  constructor(private readonly prefix: string, protected readonly backend: IStorage = global.localStorage) {}

  get(key: string) {
    const bytes = this.backend.getItem(`${this.prefix}::binary::${key}`);
    if (bytes) return Promise.resolve(fromBase64(bytes));

    const string = this.backend.getItem(`${this.prefix}::string::${key}`);
    if (string) return Promise.resolve(string);

    return Promise.resolve(undefined);
  }

  set(key: string, value: string | Uint8Array) {
    if (typeof value === 'string') {
      this.backend.setItem(`${this.prefix}::string::${key}`, value);
    } else {
      this.backend.setItem(`${this.prefix}::binary::${key}`, toBase64(value));
    }
    return Promise.resolve();
  }

  delete(key: string) {
    this.backend.removeItem(`${this.prefix}::binary::${key}`);
    this.backend.removeItem(`${this.prefix}::string::${key}`);
    return Promise.resolve();
  }

  keys() {
    const keys: string[] = [];
    for (let i = 0; i < this.backend.length; i++) {
      let key = this.backend.key(i);
      if (key?.startsWith(this.prefix)) {
        key = key.slice(this.prefix.length + 2);
        key = key.replace(/^binary::|string::/, '');
        keys.push(key);
      }
    }
    return Promise.resolve(keys);
  }
}
