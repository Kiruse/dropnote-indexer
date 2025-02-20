import { addresses, type CosmosNetworkConfig, type Signer } from '@apophis-sdk/core';
import type { Coin } from '@apophis-sdk/core/types.sdk.js';
import { Bank, Cosmos } from '@apophis-sdk/cosmos';
import { DEV_PUBKEY } from './constants';

export interface SendDropnoteOptions {
  /** The network you wish to send the Dropnote on. */
  network: CosmosNetworkConfig;
  /** The signer you wish to use to send the message with. */
  signer: Signer;
  /** The recipient of your message.
   *
   * *Note:* This will soon be deprecated in favor of the `recipients` array field.
   */
  recipient: string;
  /** The message you wish to send. Note that the blockchain may limit the size of the message, and
   * I currently don't know how to check the maximum allowed size.
   */
  message: string;
  /** The tip you wish to send along to the indexer. Some indexers may require a minimum tip to
   * index your tx, but every indexer requires at least a tiny tip to receive the message.
   */
  tip: Coin;
  /** The address of the indexer which you are watching for txs. */
  indexerAddress?: string;
}

/** Get a transaction for sending a Dropnote. You will still need to sign & broadcast the transaction. Useful for altering the transaction before broadcasting. */
export async function getDropnoteTx({ network, ...opts }: SendDropnoteOptions) {
  const devAddress = addresses.compute(network, DEV_PUBKEY);
  const signdata = opts.signer.getSignData(network)[0];
  const userAddress = signdata?.address;
  if (!signdata) throw new Error('Signer not connected');

  const tx = Cosmos.tx([
    // "ping" dev wallet
    new Bank.Send({
      fromAddress: userAddress,
      toAddress: devAddress,
      amount: [Cosmos.coin(1n, opts.tip.denom)],
    }),
    // "ping" indexer wallet w/ tip
    new Bank.Send({
      fromAddress: userAddress,
      toAddress: opts.indexerAddress ?? addresses.compute(network, DEV_PUBKEY),
      amount: [opts.tip],
    }),
  ]);

  // TODO: implement encryption
  // TODO: implement multi-recipient by BankSendMsg
  tx.memo = `dropnote:[${opts.recipient}:${opts.message}]`;

  const { gasLimit } = await tx.estimateGas(network, opts.signer, false);
  tx.computeGas(network, gasLimit + 50000n, true);
  return tx;
}

/** Create & broadcast a transaction for sending a Dropnote. Includes some rudimentary error
 * wrapping for easier handling.
 */
export async function sendDropnote(opts: SendDropnoteOptions) {
  const { network } = opts;
  try {
    const tx = await getDropnoteTx(opts);
    await opts.signer.sign(network, tx);
    return await tx.broadcast();
  }
  catch (err: any) {
    if (err.name === 'RestError') {
      if (err.message.match(/(fee payer address:|account) .*? does not exist/ig))
        throw new NotFoundError('Address not found. Please ensure you are on the correct network, and that you have deposited funds to your address.');
      if (err.message.match(/spendable balance .*? is smaller than (.*?):/ig)) {
        // TODO: tell the user how much they need
        throw new InsufficientFundsError();
      }
    }
    if (err.message.match(/401 \(Unauthorized\)/gi))
      throw new DropnoteSendError('Unauthorized. Something went horribly wrong.');
    throw err;
  }
}

export class DropnoteSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InsufficientFundsError extends DropnoteSendError {
  constructor() {
    super(`Insufficient funds`);
  }
}

export class NotFoundError extends DropnoteSendError {
  constructor(message: string) {
    super(message);
  }
}
