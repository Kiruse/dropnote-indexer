import { addresses, type CosmosNetworkConfig } from '@apophis-sdk/core';
import { TendermintQuery as TQ } from '@apophis-sdk/cosmos/tmquery.js';
import { Cosmos } from '@apophis-sdk/cosmos';
import type { CosmosTransaction, CosmosEvent } from '@apophis-sdk/core/types.sdk.js';
import { Event } from '@kiruse/typed-events';
import { type TxEvent, type Note, type DropnoteSource, type IDropnoteKVStorage, type DropnoteTxResult, type Announcement, WrappedEvent } from './types.js';
import { DEV_PUBKEY } from './constants.js';
import { EventParsingError, MemoParsingError } from './errors.js';
import { findSender } from './utils.js';

type Unsub = () => void;

export interface DropnoteIndexerOptions {
  storage: IDropnoteKVStorage;
}

export type DropnoteMemoHandler = (
  indexer: DropnoteIndexer,
  network: CosmosNetworkConfig,
  tx: CosmosTransaction,
  txResult: DropnoteTxResult,
) => Promise<void>;

export type DropnoteEventHandler = (
  indexer: DropnoteIndexer,
  network: CosmosNetworkConfig,
  tx: CosmosTransaction,
  txResult: DropnoteTxResult,
  event: CosmosEvent,
  index: number,
) => Promise<void>;

export class DropnoteIndexer {
  static #memoHandlers: Record<string, DropnoteMemoHandler> = {};
  static #eventHandlers: Record<string, DropnoteEventHandler> = {};
  #storage: IDropnoteKVStorage;

  /** An event triggered when a TX with a dropnote payload has been encountered.
   * This event is always emitted for every relevant tx, whether it is correctly formatted or not.
   * It is recommended to store these events for retroactive processing after future changes.
   *
   * You may cancel this event which will prevent it from being further processed & indexed.
   */
  readonly onTx = Event<TxEvent>();
  readonly onNote = Event<{ members: string[], note: Note, network: CosmosNetworkConfig }>();
  readonly onAnnounce = Event<Announcement>();
  readonly onError = Event<any>();

  constructor({ storage }: DropnoteIndexerOptions) {
    this.#storage = storage;
  }

  async watch(network: CosmosNetworkConfig, addrs?: string[]): Promise<Unsub> {
    addrs ??= [addresses.compute(network, DEV_PUBKEY)];
    addrs = addrs.filter(addr => addr.startsWith(network.addressPrefix));

    const unsubs: Unsub[] = [];

    addrs.forEach(addr => {
      const unsub = this.watchAddr(network, addr);
      unsubs.push(unsub);
    });

    // TODO: implement event watching
    // unsubs.push(this.watchEvents(network));

    const lastHeight = (await recoverLastHeight(network, this.#storage)) ?? (await getDefaultHeight(network));
    await Promise.all(addrs.map(async addr => {
      await this.scan(network, addr, lastHeight);
    }));

    Cosmos.ws(network).onBlock(async block => {
      await this.#storage.set(`${network.name}.height`, block.header.height.toString());
    });

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  /** Scan the given blocks for Dropnotes. You may use `Cosmos.findBlockAt` from the
   * `@apophis-sdk/core` package to find the block at a given timestamp. However, note that blocks
   * are semi-regularly pruned by non-archive nodes or after a fork. It is thus important to keep
   * the indexer live, otherwise your only option to retrieve historical data is to setup an
   * archive node, which requires a lot of disk space (several TB).
   *
   * @param network - network to backtrack on.
   * @param addr - address to check for memos. This is usually the user's wallet address or a
   * central indexer address. Defaults to the dev wallet on the given network.
   * @param fromHeight - block height to backtrack from. Defaults to current height - 864000 (30D assuming 3s block time).
   * @param toHeight - block height to backtrack to. Defaults to current height.
   */
  async scan(network: CosmosNetworkConfig, addr?: string, fromHeight?: bigint, toHeight?: bigint) {
    const cursor = await this.getTxs(network, addr, fromHeight, toHeight);
    for await (const page of cursor.pages()) {
      page.forEach(async response => {
        const tx = Cosmos.tryDecodeTx(response.tx);
        if (typeof tx === 'string') return; // malformed tx, ignore
        this.processTx(network, tx, { ...response.tx_result, height: response.height }).catch(e => this.onError.emit(e));
      });
    }

    // TODO: get txs by dropnote events
  }

  /** Watch the given network for memos. This resembles the primary indexing method.
   *
   * **Note** that calling this method twice with the same address & network will result in duplicate events.
   *
   * **Also note** that public nodes tend to have subscription limits, so you should use this method
   * sparingly, unless you bring your own full node.
   *
   * @param network - network to watch.
   * @param addr - address to watch. Should match the address prefix of the network, otherwise it
   * will yield no results. Defaults to the dev wallet on the given network. You may want to watch
   * the dev wallet alongside your own address to ensure you capture all dropnotes.
   * @returns an "unwatch" function to stop watching.
   */
  watchAddr(network: CosmosNetworkConfig, addr?: string): Unsub {
    // onTx does not require an established connection so we can fire it off first
    const ws = Cosmos.ws(network);
    addr ??= addresses.compute(network, DEV_PUBKEY);

    const unsub = ws.onBlock(async block => {
      const query = new TQ()
        .exact('transfer.recipient', addr)
        .exact('tx.height', block.header.height);
      const txs = await ws.searchTxs(query).all();
      for (const tx of txs) {
        const result = tx.tx_result;
        const tx2 = Cosmos.tryDecodeTx(tx.tx);
        if (result.code || typeof tx2 === 'string') continue;

        this.processTx(
          network,
          tx2,
          {
            ...result,
            height: tx.height,
            txhash: tx.hash,
          }
        ).catch(e => this.onError.emit(e));
      }
    });

    // initialize websocket connection
    return unsub;
  }

  /** Watch the given network for event logs, optionally emitted by only the given smart contract's
   * address.
   *
   * *Info:* Monitoring events enables possible future support for new Chain Modules to emit Dropnotes.
   *
   * ***Not yet implemented.***
   *
   * @param network - network to watch.
   * @param addr - address to watch. Should match the address prefix of the network, otherwise it
   * will yield no results. When omitted, all events emitted by any address on the given network will
   * be watched.
   * @returns an "unwatch" function to stop watching.
   */
  watchEvents(network: CosmosNetworkConfig, addr?: string): Unsub {
    throw new Error('Not yet implemented');
  }

  /** Get all potentially relevant transactions in the given block range.
   *
   * @param network - network to scan.
   * @param addresses - addresses to scan. Filters for addresses with the correct prefix for the network.
   * @param fromHeight - block height to backtrack from. Defaults to current height - 864000 (30D assuming 3s block time).
   * @param toHeight - block height to backtrack to. Defaults to current height.
   */
  async getTxs(network: CosmosNetworkConfig, addr?: string, fromHeight?: bigint, toHeight?: bigint) {
    const ws = Cosmos.ws(network);
    await ws.ready();

    const { block: currBlock } = (!fromHeight || !toHeight) ? await ws.getBlock() : { block: undefined };

    // ~30D in the past assuming 3s block time
    if (!fromHeight) fromHeight = currBlock!.header.height - 864000n;
    // fix current height for the sake of pagination
    if (!toHeight) toHeight = currBlock!.header.height;

    addr ??= addresses.compute(network, DEV_PUBKEY);

    // find any txs that match any of the network addresses in the given height range
    const query = new TQ()
      .exact('transfer.recipient', addr)
      .compare('tx.height', '>=', fromHeight)
      .compare('tx.height', '<=', toHeight);

    const res = await ws.searchTxs(query);
    await res.ready();
    return res;
  }

  /** Processes the given tx */
  async processTx(
    network: CosmosNetworkConfig,
    tx: CosmosTransaction,
    txResult: DropnoteTxResult,
  ): Promise<void> {
    if (txResult.code) return;

    let memo = tx.body?.memo;
    const source: DropnoteSource | undefined =
      this.isDropnoteMemo(memo) ? 'memo' :
      this.isDropnoteEvent(txResult.events) ? 'events' :
      undefined;
    if (!source) return;

    // no matter whether this tx is fully compliant, we still emit it for forward compatibility
    const evTx = await this.onTx.emit({ tx, network, source });
    if (evTx.canceled) return;

    switch (source) {
      case 'memo': await this.processByMemo(network, tx, txResult); break;
      case 'events': await this.processByEvents(network, tx, txResult); break;
    }
  }

  /** Process a dropnote found in a memo. Called after `onTx` has been emitted. */
  protected async processByMemo(
    network: CosmosNetworkConfig,
    tx: CosmosTransaction,
    txResult: DropnoteTxResult,
  ): Promise<void> {
    let memo = tx.body!.memo;
    const type = memo.split(':', 2)[0];
    const subtype = type.split('.')[1] ?? 'message';
    DropnoteIndexer.#memoHandlers[subtype]?.(this, network, tx, txResult).catch(
      e => this.onError.emit(new MemoParsingError(network, tx, txResult, e))
    );
  }

  /** Process a dropnote found in events. Called after `onTx` has been emitted. */
  protected async processByEvents(
    network: CosmosNetworkConfig,
    tx: CosmosTransaction,
    txResult: DropnoteTxResult,
  ): Promise<void> {
    const events = txResult.events.filter(e => e.type === 'dropnote');
    events.forEach((event, index) => {
      const subtype = event.attributes.find(a => a.key === 'type')?.value;
      if (!subtype) return;
      DropnoteIndexer.#eventHandlers[subtype]?.(this, network, tx, txResult, event, index).catch(
        e => this.onError.emit(new EventParsingError(network, tx, txResult, event, e))
      );
    });
  }

  /** Checks whether the given memo is a dropnote memo. Can be overridden to support custom memo formats. */
  isDropnoteMemo(memo: string | undefined): memo is string {
    return memo?.match(/^dropnote(\.\w+)?:/i) !== null;
  }

  /** Checks whether the given events contain a dropnote event. */
  isDropnoteEvent(events: CosmosEvent[]): boolean {
    return events.some(e => e.type === 'dropnote');
  }

  /** Register a new handler for a specific memo subtype.
   *
   * @param subtype of the memo to handle. The only special case is `message` which is the default when no subtype is given (i.e. `dropnote:` memo prefix).
   * @param handler to call when a memo with the given subtype is encountered.
   */
  static handleMemo(subtype: string, handler: DropnoteMemoHandler) {
    this.#memoHandlers[subtype] = handler;
  }

  /** Register a new handler for a specific event subtype.
   *
   * @param subtype of the event to handle.
   * @param handler to call when a event with the given subtype is encountered.
   */
  static handleEvent(subtype: string, handler: DropnoteEventHandler) {
    this.#eventHandlers[subtype] = handler;
  }
}

async function recoverLastHeight(network: CosmosNetworkConfig, storage: IDropnoteKVStorage) {
  const height = await storage.get(`${network.name}.height`);
  return typeof height === 'string' ? BigInt(height) : undefined;
}

/** The default height is ~30D ago assuming 3s block time */
async function getDefaultHeight(network: CosmosNetworkConfig) {
  const ws = Cosmos.ws(network);
  await ws.ready();
  const { block } = await ws.getBlock();
  return block!.header.height - 864000n;
}

DropnoteIndexer.handleMemo('message', async (indexer, network, tx, txResult) => {
  let memo = tx.body!.memo;
  const txhash = txResult.txhash ?? Cosmos.getTxHash(tx);
  const sender = findSender(txResult.events);
  if (!sender)
    throw new Error(`Failed to find sender for message event in tx memo ${txhash}: ${tx.body!.memo}`);

  memo = memo.slice(memo.indexOf(':') + 1);

  let encrypted = false, message: string, recipient: string;
  if (!memo.startsWith(`[`)) {
    encrypted = true;
    // TODO: implement decryption
    throw new Error('Encryption not yet implemented');
  } else {
    const tmp = memo.slice(1, -1);
    const [p0, ...messageParts] = tmp.split(':');
    recipient = p0;
    message = messageParts.join(':');
  }

  if (!recipient || !message)
    throw new Error(`Malformed message in tx memo ${txhash}: ${tx.body!.memo}`);

  const { block } = await Cosmos.ws(network).getBlock(txResult.height);
  const note: Omit<Note, 'convoId'> = {
    txhash,
    chain: network.name,
    index: 'memo',
    sender,
    message,
    encrypted,
    timestamp: block.header.time,
  };

  indexer.onNote.emit({ note, members: [sender, recipient], network });
});

DropnoteIndexer.handleMemo('announce', async (indexer, network, tx, txResult) => {
  let memo = tx.body!.memo;
  const txhash = txResult.txhash ?? Cosmos.getTxHash(tx);
  const sender = findSender(txResult.events);
  if (!sender)
    throw new Error(`Failed to find sender for announce event in tx memo ${txhash}: ${tx.body!.memo}`);

  memo = memo.slice(memo.indexOf(':') + 1);

  let encrypted = false, message: string;
  if (!memo.startsWith(`[`)) {
    encrypted = true;
    // TODO: implement decryption
    throw new Error('Encryption not yet implemented');
  } else {
    message = memo.slice(1, -1);
  }

  if (!message)
    throw new Error(`Malformed announce event in tx memo ${txhash}: ${tx.body!.memo}`);

  const { block } = await Cosmos.ws(network).getBlock(txResult.height);
  indexer.onAnnounce.emit({
    txhash,
    chain: network.name,
    index: 'memo',
    message,
    sender,
    encrypted,
    timestamp: block.header.time,
  });
});

DropnoteIndexer.handleEvent('message', async (indexer, network, tx, txResult, event, index) => {
  const ev = new WrappedEvent(event);
  let message = ev.attr('message');
  if (!message)
    throw new Error(`No message found in message event in tx ${Cosmos.getTxHash(tx)}`);

  const addr = ev.attr('_contract_address');
  if (!addr)
    throw new Error(`Failed to find _contract_address event attribute for message event in tx ${Cosmos.getTxHash(tx)}`);

  const recipient = ev.attr('recipient');
  if (!recipient)
    throw new Error(`Failed to find recipient event attribute for message event in tx ${Cosmos.getTxHash(tx)}`);

  const sender = ev.attr('sender');
  const { block } = await Cosmos.ws(network).getBlock(txResult.height);

  let encrypted = ev.attr('encrypted') === 'true';
  if (encrypted) {
    // TODO: implement decryption
    throw new Error('Encryption not yet implemented');
  }

  indexer.onNote.emit({
    members: [sender ?? addr, recipient],
    note: {
      txhash: Cosmos.getTxHash(tx),
      chain: network.name,
      index,
      sender: sender ?? addr,
      message,
      encrypted,
      timestamp: block.header.time,
    },
    network,
  });
});

DropnoteIndexer.handleEvent('announce', async (indexer, network, tx, txResult, event, index) => {
  const ev = new WrappedEvent(event);
  let message = ev.attr('message');
  if (!message)
    throw new Error(`No message found in announce event in tx ${Cosmos.getTxHash(tx)}`);

  const addr = ev.attr('_contract_address');
  if (!addr)
    throw new Error(`Failed to find _contract_address event attribute for announce event in tx ${Cosmos.getTxHash(tx)}`);

  const sender = ev.attr('sender');
  const { block } = await Cosmos.ws(network).getBlock(txResult.height);

  let encrypted = ev.attr('encrypted') === 'true';
  if (encrypted) {
    // TODO: implement decryption
    throw new Error('Encryption not yet implemented');
  }

  indexer.onAnnounce.emit({
    txhash: Cosmos.getTxHash(tx),
    chain: network.name,
    index,
    message,
    timestamp: block.header.time,
    sender: sender ?? addr,
    encrypted,
  });
});
