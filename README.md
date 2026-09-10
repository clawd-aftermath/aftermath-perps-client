# aftermath-perps-client

A strict, ESM-only TypeScript client for consuming Aftermath Perpetuals state
in headless services or React applications.

- Framework-neutral immutable store
- Native Aftermath REST bootstrap and general-updates WebSocket
- Mandatory REST snapshot after every socket open or reconnect
- Per-market bigint orderbook nonce validation and bounded resync buffering
- Decimal-safe walletless orderbook simulation for base or quote input
- Explicit separation between local execution estimates and authoritative
  backend margin/collateral/liquidation/validity previews
- Selector-aware optional React hooks
- No wallet, signing, transaction submission, or deployment behavior

> **Status:** v0.1.0. This package is an integration primitive, not a trading
> bot. Local estimates are not executable quotes and do not establish margin
> safety.

## Install

```bash
npm install aftermath-perps-client decimal.js
```

For React hooks:

```bash
npm install react
```

The core adapter is structural and does not import `aftermath-ts-sdk` at
runtime. Consumers can pass an SDK market client to the preview adapter without
installing an SDK peer on behalf of this package.

This package publishes ESM only. Use `import`; CommonJS `require()` is not a
supported entry point.

## Headless store

```ts
import { createPerpsStore, selectOrderbook, simulateOrderbook } from "aftermath-perps-client";
import {
  createAftermathNativeSnapshotSource,
  createAftermathWebSocketStream,
} from "aftermath-perps-client/aftermath";

const marketId = "0x...";
const store = createPerpsStore({
  snapshotSource: createAftermathNativeSnapshotSource({
    collateralCoinType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  }),
  stream: createAftermathWebSocketStream({
    subscriptions: [
      { market: { marketId } },
      { oracle: { marketId } },
      { orderbook: { marketId } },
    ],
  }),
});

await store.start();

const book = selectOrderbook(marketId)(store.getState());
if (book) {
  console.log(
    simulateOrderbook(book, {
      side: "buy",
      input: "quote",
      amount: "250.00",
    }),
  );
}
```

The snapshot source uses these native routes:

- `POST /api/perpetuals/all-markets`
- `POST /api/perpetuals/markets`
- `POST /api/perpetuals/markets/prices`
- `POST /api/perpetuals/markets/orderbooks`
- `POST /api/perpetuals/accounts/positions` when account IDs are configured
- `POST /api/perpetuals/vaults` unless disabled

The stream uses only `/api/perpetuals/ws/updates`. The built-in decoder and
subscription type support `market`, `oracle`, and `orderbook`
subscriptions. Use `decodeMessage` with `onUnhandledMessage` when extending
the transport for another server payload.

Account IDs are numeric Aftermath IDs, not capability object IDs. Construction
accepts non-negative `bigint` values or unsigned base-10 strings and rejects
invalid identifiers immediately. REST requests serialize them as exact bigint
wire strings such as `"123n"`.

Native HTTP calls send `Accept: application/json`, combine caller aborts with
a bounded 10-second timeout, and accept a positive `timeoutMs` override.

## Reconnect correctness

Data is marked `stale: true` immediately when the socket disconnects. Every
new socket remains non-live until a fresh REST snapshot atomically replaces all
collections.

Orderbook sequencing is independent per market. The REST snapshot carries each
book's bigint `nonce`; buffered WS `orderbookDeltas` are sorted and replayed
against only that market's nonce. Duplicate or older nonces are ignored, and a
nonce gap triggers another snapshot. Unsequenced market/oracle messages received
during resync are discarded because they cannot be proven newer than the
snapshot. The resync buffer is bounded by `maxBufferedDeltas`.

Calling `stop()` deliberately resolves a pending initial start, cancels
network work, and prevents reconnect. Calling `resync()` while stopped rejects;
call `start()` to restart and obtain the mandatory socket snapshot.

## Local simulation

`simulateOrderbook` accepts either:

- `input: "base"` — target base-asset amount
- `input: "quote"` — target quote notional to spend/receive

It returns best and volume-weighted average execution price, slippage, fills,
filled base, filled quote notional, fillable input, and unfilled input. Partial
fills are first-class results.

Arithmetic runs in a package-local `decimal.js` clone configured for 80
significant digits; it does not mutate the global Decimal constructor. Decimal
strings and bigints preserve caller input exactly. JavaScript numbers are
accepted, but precision already lost before the call cannot be recovered.
Hexadecimal and other non-decimal literal strings are rejected.

For a base request, `unfilledBaseAmount` is populated and
`unfilledQuoteNotional` is `null` because no execution price exists for
unavailable liquidity. Quote requests do the inverse.

## Authoritative preview boundary

```ts
import {
  createAftermathSdkMarketPreviewAdapter,
  previewOrder,
} from "aftermath-perps-client";

const backend = createAftermathSdkMarketPreviewAdapter(market);
const result = await previewOrder({
  orderbook,
  localRequest: { side: "buy", input: "base", amount: "1.25" },
  backendRequest: {
    side: 0,
    size: 1_250_000_000n,
    collateralChange: 100,
    reduceOnly: false,
  },
  backend,
});
```

The local side estimates only orderbook execution. The backend result is
authoritative for margin, collateral sufficiency, liquidation implications, and
protocol validity. Aftermath previews may return `{ error }` with HTTP 200;
the adapter converts that payload into `status: "error"`.

## React

```tsx
import { createPerpsHooks } from "aftermath-perps-client/react";

const hooks = createPerpsHooks(store);

export function BestAsk({ marketId }: { marketId: string }) {
  const book = hooks.useOrderbook(marketId);
  return <span>{book?.asks[0]?.price ?? "—"}</span>;
}
```

React subscriptions compare the selected snapshot with `Object.is`, so
unrelated store updates do not rerender entity hooks. Collection/filter
selectors cache results by immutable collection identity. Importing the root
package does not import React.

## API semantics

This package follows the inspected Aftermath 5.0.2 declarations and checked
wire fixtures:

- market and vault IDs are Sui object IDs;
- account and order IDs are represented without numeric loss;
- side `0` is bid/buy and `1` is ask/sell;
- position `baseAssetAmount` is signed; public size is absolute;
- pending-order filled size is `initialSize - currentSize`;
- REST orderbook wrappers are correlated positionally to requested market IDs;
- orderbook nonces are bigint and scoped per market;
- market/oracle WS patches merge into REST entities without erasing metadata;
- preview responses are success/error unions.

## Examples

- [Headless TypeScript](https://github.com/AftermathFinance/aftermath-perps-client/blob/main/examples/headless.ts)
- [Minimal React](https://github.com/AftermathFinance/aftermath-perps-client/blob/main/examples/react.tsx)
- [Architecture](https://github.com/AftermathFinance/aftermath-perps-client/blob/main/docs/architecture.md)

## Acknowledgement

The public module layering of
[elliottech/lighter-ts](https://github.com/elliottech/lighter-ts) informed the
separation of state, transport, formulas, and UI adapters. This repository is an
original implementation, not a mechanical fork, and includes no copied
`lighter-ts` source.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
