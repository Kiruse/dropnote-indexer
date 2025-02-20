# @kiruse/dropnote-indexer
The Dropnote Indexer extracts Dropnote protocol messages from blockchain transactions & emits various events. It is recommended to store these events in some form as messages may disappear due to block pruning.

## Setup
Install with your favorite package manager's equivalent of:

```bash
npm install @apophis-sdk/core @kiruse/dropnote-indexer
```

## Usage

```ts
import { Apophis, Cosmos, DefaultCosmosMiddlewares } from '@apophis-sdk/cosmos';
import { DropnoteIndexer } from '@kiruse/dropnote-indexer';
import { JsonStorage } from '@kiruse/dropnote-indexer/storage/json-storage';
import { DateTime } from 'luxon';

Apophis.use(...DefaultCosmosMiddlewares);

// fetch neutron testnet network from registry & add custom endpoints
// although the retrieved network config already contains endpoints, I found not all of them are
// reliable, so I recommend always adding your own custom endpoints.
const network = {
  ...(await Cosmos.getNetworkFromRegistry('neutrontestnet')),
  endpoints: {
    rest: ['https://rest-falcron.pion-1.ntrn.tech'],
    rpc: ['https://rpc-falcron.pion-1.ntrn.tech'],
    ws: ['wss://rpc-falcron.pion-1.ntrn.tech/websocket'],
  },
};

const indexer = new DropnoteIndexer({
  // there are different storage implementations available, or you can bring your own
  storage: new JsonStorage('./db.json'),
});

// handle new detected notes, e.g. store them in a database or forward them to a message broker
indexer.onNote(({ args: evNote }) => {
  // ...
});

indexer.onError(({ args: error }) => console.error(error));

// watch the network for new messages. this will
// 1) recover potentially missed messages except in certain edge cases (that are largely out of our control)
// 2) watch the network for memos on `BankSendMsg`s to the Dev Wallet
// 3) watch the network for Dropnote events emitted by smart contracts or chain modules
// 4) track the last block height processed
const stop = indexer.watch(network);

// stop watching the network
stop();

// note that you may need to close the underlying Apophis WebSocket connection
Cosmos.ws(network).close();

// or otherwise simply exit the process
process.exit(0);
```

The Indexer's storage is not used to store transactions or processed messages, but rather to store lesser metadata such as the last seen block height for a better recovery after an outage. There are various storage implementations available in the `@kiruse/dropnote-indexer/storage.js` submodule, or you can implement your own `IDropnoteKVStorage` interface (from `@kiruse/dropnote-indexer/types.js`).

## `onTx` Event
The `onTx` event is emitted when a transaction is encountered that may contain a Dropnote message. This event is not emitted for transactions that failed as they have been rejected by the blockchain anyways.

You may to save these txs to your database for the sake of forward compatibility. In case of future protocol changes, or your own divergence from the reference implementation, you may need to revisit these transactions to ensure messages are not missed. This is recommended because regular full nodes may periodically prune old blocks, thus txs will be pruned as well; only so-called Archive Nodes keep a record of all historical blocks & txs, which are quite expensive to run & maintain.

You may also cancel the event to prevent it from being processed further. This is useful e.g. if you employ additional logic to filter out spam or levy a fee for the indexing of your users' messages.

## Sending Dropnotes
This library also comes with a standard `sendDropnote` method that can be used to send Dropnotes to the network which your indexer will then pick up. Additional methods for different types of Dropnotes such as Announcements will be added in the future.

```typescript
import { Apophis, Cosmos, DefaultCosmosMiddlewares } from '@apophis-sdk/cosmos';
import { LocalSigner } from '@apophis-sdk/cosmos/local-signer';
import { sendDropnote } from '@kiruse/dropnote-indexer/send';

Apophis.use(...DefaultCosmosMiddlewares);

// you may want to configure other signers from @apophis-sdk/cosmos-signers for frontend support

const signer = LocalSigner.fromMnemonic('...');
// recipient of your Dropnote (not of the tip!)
const recipient = 'neutron1...';
const message = 'Hello, world!';

// the tip is always required as the indexer watches for Bank Send messages. however, for your
// own indexer, it is sufficient to send 1untrn, which is 1-millionth of a NTRN. other indexers
// may require a higher tip.
const tip = Cosmos.coin(1n, 'untrn');

const network = await Cosmos.getNetworkFromRegistry('neutrontestnet');

const txhash = await sendDropnote({
  network,
  signer,
  recipient,
  message,
  tip,
  // optional indexer address which also receives the tip - defaults to dev wallet
  indexerAddress: 'neutron1...',
});
```

**Note** that, although the dev wallet is the default indexer address, it does not guarantee that your Dropnote will be indexed. It is merely the conventional standard address that all Dropnotes should be sent to if you wish to participate in the public network.

**Note** also that you do not need to index your own address, you may simply use it to receive tips and index on the default address instead.

# License
The MIT License (MIT)
Copyright © 2024 Kiruse

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
