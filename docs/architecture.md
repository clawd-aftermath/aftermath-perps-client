# Architecture

The package has four deliberately separate layers:

1. **Domain store** — immutable snapshots for markets, prices/oracles,
   orderbooks, accounts, positions, orders, collateral, funding, and vaults.
2. **Lifecycle** — a transport-neutral REST snapshot source plus a WebSocket
   delta stream. Every socket open, including reconnect, enters `resyncing`;
   data is stale until the REST snapshot atomically replaces state.
3. **Local estimation** — orderbook walking with a package-local, 80-significant-
   digit Decimal constructor. It never estimates margin, liquidation,
   collateral sufficiency, or protocol validity.
4. **Authoritative preview** — a structural adapter around Aftermath SDK/API
   preview calls. Preview `{ error }` payloads are failures even when HTTP
   status is 200.

## Reconnect invariant

```text
socket open -> stale/resyncing -> REST snapshot with per-market book nonces
            -> replay bounded, newer contiguous deltas per market -> live
```

Orderbook nonce ordering is not global. For each market, a delta at or below the
snapshot/current book nonce is ignored and a nonce greater than
`current + 1n` forces another snapshot. Deltas for different markets do not
constrain one another. Unsequenced market/oracle messages received during
resync are discarded; once live, they are merged into the REST entity so
display metadata and other omitted fields remain intact.

The buffer has a configurable positive `maxBufferedDeltas` bound. Overflow
aborts the active synchronization and reconnects instead of allowing unbounded
memory growth.

A successful synchronization resets reconnect backoff. Deliberate `stop()`
cancels work without rejecting an unattended start promise. `resync()` never
implicitly starts a stopped store.

## Data boundaries

Entities preserve the source payload in `raw`, but selectors and simulations
use normalized fields. Market/vault IDs are Sui object IDs. Account IDs are
unsigned numeric identifiers represented without loss as strings; the HTTP
adapter writes them as exact `"123n"` wire values.

REST orderbook response entries do not contain a market ID, so the adapter
correlates each wrapper positionally with the exact `marketIds` request.
Snapshots and deltas retain bigint book nonces. Signed position
`baseAssetAmount` determines side and is exposed as absolute size. Account
collateral comes only from `availableCollateral`, `availableCollateralUsd`,
and `totalEquityUsd`.
