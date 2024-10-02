import { pubkey } from '@apophis-sdk/core/crypto/pubkey.js';
import { fromHex } from '@apophis-sdk/core/utils.js';

/** The default address that the indexer will watch for memos, next to your own specified addresses. */
export const DEV_PUBKEY = pubkey.secp256k1(fromHex('0221f705fbd96c33d07dda2599055092b82cdf4ecdc1f799771069f73279e9a61b'));
