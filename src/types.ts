import type { CosmosNetworkConfig } from '@apophis-sdk/core';
import type { CosmosEvent, CosmosTransaction } from '@apophis-sdk/core/types.sdk.js';

export type DropnoteSource = 'memo' | 'events';

export interface TxEvent {
  network: CosmosNetworkConfig;
  tx: CosmosTransaction;
  /** The data source that was used to find this tx. */
  source: DropnoteSource;
}

export interface NoteEvent {
  network: CosmosNetworkConfig;
  /** The transaction that this note was found in. */
  tx: CosmosTransaction;
  /** The data source that was used to find this note. */
  source: DropnoteSource;
  /** The dropnote that was sent. */
  note: Note;
  /** Both sender & recipients of the dropnote. */
  members: string[];
}

export type NoteIndex = 'memo' | number;

export interface Note {
  /** Hash of the transaction that this note was found in. */
  txhash: string;
  /** Registered name of the corresponding blockchain. */
  chain: string;
  /** The event index of the note in the transaction. 'memo' if found in a memo, otherwise a number. */
  index: NoteIndex;
  timestamp: Date;
  sender: string;
  message: string;
  /** Whether the note is encrypted. */
  encrypted?: boolean;
}

export interface Announcement {
  /** Hash of the transaction that this announcement was found in. */
  txhash: string;
  /** Registered name of the corresponding blockchain. */
  chain: string;
  /** The event index of the note in the transaction. */
  index: NoteIndex;
  /** The sender of the announcement. This is typically an address, but doesn't have to be in case
   * of chain modules. The reference implementation, however, currently enforces this to be the
   * address of the smart contract that sent the announcement.
   */
  sender: string;
  /** The announcement message. */
  message: string;
  /** The timestamp of the announcement. */
  timestamp: Date;
  /** Whether the announcement is encrypted. */
  encrypted?: boolean;
}

export interface IDropnoteKVStorage {
  get(key: string): Promise<string | Uint8Array | undefined>;
  set(key: string, value: string | Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface DropnoteTxResult {
  code?: number;
  txhash?: string;
  height: bigint;
  events: CosmosEvent[];
}

export class WrappedEvent {
  constructor(public readonly base: CosmosEvent) {}

  /** Get the `index`th attribute of type `key` from the event, if any. */
  attr(key: string, index = 0): string | undefined {
    return this.base.attributes.filter(a => a.key === key)[index]?.value;
  }
  attrs(key?: string) {
    return key ? this.base.attributes.filter(a => a.key === key) : this.base.attributes;
  }

  /** Same as `attr`, but throws an error if the attribute is not found. */
  expectAttr(key: string, index = 0): string {
    const value = this.attr(key, index);
    if (!value)
      throw new Error(`Expected attribute ${key} at index ${index} in event ${this.type}, but not found.`);
    return value;
  }

  get type() { return this.base.type }
}
