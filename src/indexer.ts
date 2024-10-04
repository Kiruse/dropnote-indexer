import { addresses as addr, addresses, Cosmos, type NetworkConfig } from '@apophis-sdk/core';
import { TendermintQuery as TQ } from '@apophis-sdk/core/query.js';
import type { CosmosTransaction, CosmosEvent } from '@apophis-sdk/core/types.sdk.js';
import { Event } from '@kiruse/typed-events';
import { type TxEvent, type Note, type DropnoteSource, type IDropnoteKVStorage } from './types.js';
import { DEV_PUBKEY } from './constants.js';
import { getEventAttribute, warn } from './utils.js';

type Unsub = () => void;

// there are different possible prefixes, however, we currently only support this one
const PREFIX_MESSAGE = 'dropnote:';

export interface DropnoteIndexerOptions {
  storage: IDropnoteKVStorage;
}

export class DropnoteIndexer {
  #storage: IDropnoteKVStorage;

  /** An event triggered when a TX with a dropnote payload has been encountered.
   * This event is always emitted for every relevant tx, whether it is correctly formatted or not.
   * It is recommended to store these events for retroactive processing after future changes.
   *
   * You may cancel this event which will prevent it from being further processed & indexed.
   */
  readonly onTx = Event<TxEvent>();
  readonly onNote = Event<{ members: string[], note: Omit<Note, 'convoId'> }>();
  readonly onError = Event<any>();

  constructor({ storage }: DropnoteIndexerOptions) {
    this.#storage = storage;
  }

  async watch(network: NetworkConfig, addrs?: string[]): Promise<Unsub> {
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
  async scan(network: NetworkConfig, addr?: string, fromHeight?: bigint, toHeight?: bigint) {
    const cursor = await this.getTxs(network, addr, fromHeight, toHeight);
    for await (const page of cursor.pages()) {
      page.forEach(async response => {
        const tx = Cosmos.tryDecodeTx(response.tx);
        if (typeof tx === 'string') return; // malformed tx, ignore
        this.onTx.emit({ tx, network, source: 'memo' });
        this.processTx(network, tx, { ...response.tx_result, height: response.height }, 'memo').catch(e => this.onError.emit(e));
      });
    }
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
  watchAddr(network: NetworkConfig, addr?: string): Unsub {
    // onTx does not require an established connection so we can fire it off first
    const ws = Cosmos.ws(network);
    addr ??= addresses.compute(network, DEV_PUBKEY);

    const query = new TQ().exact('transfer.recipient', addr);
    const unsub = ws.onTx(query, async tx => {
      if (tx.error) return;
      this.processTx(
        network,
        tx.tx,
        {
          ...tx.result,
          height: tx.height,
          txhash: tx.txhash,
        },
        'memo',
      ).catch(e => this.onError.emit(e));
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
  watchEvents(network: NetworkConfig, addr?: string): Unsub {
    throw new Error('Not yet implemented');
  }

  /** Get all potentially relevant transactions in the given block range.
   *
   * @param network - network to scan.
   * @param addresses - addresses to scan. Filters for addresses with the correct prefix for the network.
   * @param fromHeight - block height to backtrack from. Defaults to current height - 864000 (30D assuming 3s block time).
   * @param toHeight - block height to backtrack to. Defaults to current height.
   */
  async getTxs(network: NetworkConfig, addr?: string, fromHeight?: bigint, toHeight?: bigint) {
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
    network: NetworkConfig,
    tx: CosmosTransaction,
    txResult: { code?: number, txhash?: string, height: bigint, events: CosmosEvent[] },
    source: DropnoteSource,
  ): Promise<[string[], Note] | undefined> {
    if (txResult.code) return;

    const sender = txResult.events.find(e => e.type === 'message')?.attributes.find(a => a.key === 'sender')?.value;
    if (!sender) return;

    const txhash = txResult.txhash ?? await Cosmos.getTxHash(tx);
    let memo = tx.body?.memo;
    if (!this.isDropnoteMemo(memo)) return;

    // no matter whether this tx is fully compliant, we still emit it for forward compatibility
    const evTx = await this.onTx.emit({ tx, network, source });
    if (evTx.canceled) return;

    // TODO: change behavior depending on message prefix
    memo = memo.slice(PREFIX_MESSAGE.length);

    let encrypted = false;
    if (!memo.startsWith(`[`)) {
      encrypted = true;
      // TODO: implement decryption
      throw new Error('Encryption not yet implemented');
    }

    memo = memo.slice(1, -1);
    const [recipient, ...messageParts] = memo.split(':');
    const message = messageParts.join(':');
    if (!message) {
      console.warn(`Malformed message in tx ${txhash}:`, tx.body!.memo);
      return;
    }

    const { block } = await Cosmos.ws(network).getBlock(txResult.height);
    const note: Omit<Note, 'convoId'> = {
      chain: network.name,
      sender,
      message,
      encrypted,
      timestamp: block.header.time,
      txhash,
    };

    this.onNote.emit({ members: [sender, recipient].sort(), note });
  }

  /** Checks whether the given memo is a dropnote memo. Can be overridden to support custom memo formats. */
  isDropnoteMemo(memo: string | undefined): memo is string {
    return Boolean(memo?.startsWith(PREFIX_MESSAGE));
  }
}

async function recoverLastHeight(network: NetworkConfig, storage: IDropnoteKVStorage) {
  const height = await storage.get(`${network.name}.height`);
  return typeof height === 'string' ? BigInt(height) : undefined;
}

/** The default height is ~30D ago assuming 3s block time */
async function getDefaultHeight(network: NetworkConfig) {
  const ws = Cosmos.ws(network);
  await ws.ready();
  const { block } = await ws.getBlock();
  return block!.header.height - 864000n;
}
