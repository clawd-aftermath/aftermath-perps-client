import {
  type AftermathAccountExecutionSource,
  createExecutionController,
  planQuoteCycle,
  type TransactionExecutor,
} from "../src/index.js";

// Supply these from aftermath-ts-sdk and your Sui signer. This example never reads keys or submits by itself.
declare const account: AftermathAccountExecutionSource<unknown>;
declare const signer: TransactionExecutor<unknown, { digest: string }>;

const execution = createExecutionController(account, signer);
const cycle = planQuoteCycle({
  now: Date.now(), quoteObservedAt: Date.now(), marketId: "0xMARKET", positionSize: "0",
  existingOrderIds: [], orderType: 2, hasPosition: false, // PostOnly
  desired: [
    { side: "buy", price: "9.99", size: "10", clientOrderId: 1n },
    { side: "sell", price: "10.01", size: "10", clientOrderId: 2n },
  ],
  limits: { tickSize: "0.01", lotSize: "1", maxOrders: 4, maxQuoteAgeMs: 1_000, maxAbsolutePosition: "100" },
});

if (cycle.action === "halt") throw new Error(`quotes not submitted: ${cycle.reason}`);

const dryRun = true;
if (dryRun) console.dir(cycle.input, { depth: null });
else console.log(await execution.replace(cycle.input));
