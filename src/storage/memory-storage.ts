import { type IDropnoteKVStorage } from '../types.js';

export class MemoryStorage implements IDropnoteKVStorage {
  private readonly storage = new Map<string, string | Uint8Array>();

  get(key: string) {
    return Promise.resolve(this.storage.get(key));
  }

  set(key: string, value: string | Uint8Array) {
    this.storage.set(key, value);
    return Promise.resolve();
  }

  delete(key: string) {
    this.storage.delete(key);
    return Promise.resolve();
  }

  keys() {
    return Promise.resolve(Array.from(this.storage.keys()));
  }
}
