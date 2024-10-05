import type { NetworkConfig } from '@apophis-sdk/core';
import type { CosmosEvent, CosmosTransaction } from '@apophis-sdk/core/types.sdk.js';

export type DropnoteSource = 'memo' | 'events';

export interface TxEvent {
  network: NetworkConfig;
  tx: CosmosTransaction;
  /** The data source that was used to find this tx. */
  source: DropnoteSource;
}

export interface NoteEvent {
  network: NetworkConfig;
  /** The transaction that this note was found in. */
  tx: CosmosTransaction;
  /** The data source that was used to find this note. */
  source: DropnoteSource;
  /** The dropnote that was sent. */
  note: Note;
  /** Both sender & recipients of the dropnote. */
  members: string[];
}

export interface Note {
  /** Hash of the transaction that this note was found in. */
  txhash: string;
  /** Registered name of the corresponding blockchain. */
  chain: string;
  timestamp: Date;
  sender: string;
  message: string;
  /** Whether the note is encrypted. */
  encrypted?: boolean;
  /** Whether this note is hidden. */
  hidden?: boolean;
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
