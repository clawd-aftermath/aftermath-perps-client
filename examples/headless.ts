import {
  createAftermathNativeSnapshotSource,
  createAftermathWebSocketStream,
} from "../src/aftermath.js";
import {
  createPerpsStore,
  selectConnection,
  selectOrderbook,
  simulateOrderbook,
} from "../src/index.js";

const marketId = "0xmarket";

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

const unsubscribe = store.subscribe(() => {
  const connection = selectConnection(store.getState());
  console.log(connection.status, connection.stale);
});

await store.start();

const orderbook = selectOrderbook(marketId)(store.getState());
if (orderbook !== null) {
  const estimate = simulateOrderbook(orderbook, {
    side: "buy",
    input: "quote",
    amount: "1000",
  });
  console.log(estimate);
}

unsubscribe();
store.stop();
