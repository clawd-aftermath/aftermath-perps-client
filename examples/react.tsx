import { useEffect } from "react";
import {
  createAftermathNativeSnapshotSource,
  createAftermathWebSocketStream,
} from "../src/aftermath.js";
import { createPerpsStore } from "../src/index.js";
import { createPerpsHooks } from "../src/react.js";

const marketId = "0xmarket";
const store = createPerpsStore({
  snapshotSource: createAftermathNativeSnapshotSource({
    collateralCoinType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  }),
  stream: createAftermathWebSocketStream({
    subscriptions: [{ orderbook: { marketId } }, { oracle: { marketId } }],
  }),
});
const hooks = createPerpsHooks(store);

export function PerpsQuote() {
  const connection = hooks.useConnection();
  const price = hooks.usePrice(marketId);
  const orderbook = hooks.useOrderbook(marketId);

  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, []);

  return (
    <dl>
      <dt>Status</dt>
      <dd>{connection.status}</dd>
      <dt>Mark</dt>
      <dd>{price?.markPrice ?? "—"}</dd>
      <dt>Best bid / ask</dt>
      <dd>
        {orderbook?.bids[0]?.price ?? "—"} / {orderbook?.asks[0]?.price ?? "—"}
      </dd>
    </dl>
  );
}
