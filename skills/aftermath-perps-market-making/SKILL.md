---
name: aftermath-perps-market-making
description: Build or operate an Aftermath Perpetuals market maker safely, including quote validation, atomic replacement, reconciliation, and shutdown.
---

# Aftermath Perps Market Making

1. Confirm the network, market ID, account ID, tick size, lot size, leverage, position cap, and authorized agent wallet. Keep withdrawal authority outside the trading agent; finish only when each identifier and permission is verified.
2. Fetch a complete REST snapshot before opening the WebSocket. Mark state stale on disconnect, discard unverifiable deltas, and resume quoting only after a fresh snapshot plus ordered deltas produces live state.
3. Read fair value from an independent, timestamped source. Reject stale inputs, then let the operator's strategy produce desired prices and sizes; finish only when source age is inside the configured limit.
4. Read human-decimal tick and lot values from `market.tickSize()` and `market.lotSize()`; never pass already-scaled `marketParams` bigints. Validate every desired order with `planQuoteCycle`, use `PostOnly` for resting quotes, and separately ensure quotes do not cross the live market book. Maintain client order IDs across cycles; the planner only detects duplicates inside one cycle.
5. Pre-allocate required collateral. Use `getPlaceLimitOrderPreview`, `getCancelOrdersPreview`, and `getMaxOrderSize` for authoritative margin, cancellation collateral changes, and size validation. Treat local simulation as execution-quality information only.
6. Replace stale quotes through `getCancelAndPlaceOrdersTx` via `createExecutionController`. Cancel and place atomically, tolerate already-missing order IDs during reconciliation, and allow only one transaction in flight per account.
7. Create exactly one execution controller per account. Wait for a terminal result, then rebuild orders and positions from authoritative state. On failure or unknown outcome, determine whether it landed and call `acknowledgeReconciled()` only after reconciliation; never blindly retry.
8. Trigger the kill switch on stale feeds, state gaps, position-limit breaches, repeated failures, or operator command. Stop new quoting, fetch a fresh authoritative order list, call `cancelOrders` with exactly those IDs and previewed collateral changes, confirm cancellation onchain, and finish only when account state is reconciled.
9. Start in dry-run or a non-production environment with small limits. Verify reconnect recovery, partial fills, failed submissions, duplicate IDs, ambiguous outcomes, and kill-switch behavior before live submission.

This skill supplies operational guardrails, not a profitable strategy. It never chooses spreads, predicts fair value, promises returns, or handles production secrets.
