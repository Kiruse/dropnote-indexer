import { type NetworkConfig } from '@apophis-sdk/core';
import type { CosmosEvent, CosmosTransaction } from '@apophis-sdk/core/types.sdk.js';
import { Cosmos } from '@apophis-sdk/cosmos';
import type { DropnoteTxResult } from './types';

export class DropnoteIndexerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TxProcessingError extends DropnoteIndexerError {
  constructor(public readonly tx: CosmosTransaction, message?: string) {
    super(message ?? `Failed to process transaction ${Cosmos.getTxHash(tx)}`);
  }
}

export class MemoParsingError extends DropnoteIndexerError {
  constructor(
    public readonly network: NetworkConfig,
    public readonly tx: CosmosTransaction,
    public readonly txResult: DropnoteTxResult,
    public readonly cause: any,
  ) {
    super('Failed to parse Dropnote in memo: ' + cause);
  }
}

export class EventParsingError extends DropnoteIndexerError {
  constructor(
    public readonly network: NetworkConfig,
    public readonly tx: CosmosTransaction,
    public readonly txResult: DropnoteTxResult,
    /** The specific event that failed to parse. */
    public readonly event: CosmosEvent,
    public readonly cause: any,
  ) {
    super('Failed to parse Dropnote in event: ' + cause);
  }
}
