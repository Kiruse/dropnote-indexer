import { Cosmos } from '@apophis-sdk/core';
import type { CosmosTransaction } from '@apophis-sdk/core/types.sdk.js';

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
