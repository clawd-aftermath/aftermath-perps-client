import { useCallback, useRef, useSyncExternalStore } from "react";
import type { PerpsState, PerpsStore } from "./types.js";

interface SelectionCache<T> {
  hasValue: boolean;
  value: T | undefined;
}

export function subscribeWithSelector<T>(
  store: PerpsStore,
  selector: (state: PerpsState) => T,
  onChange: () => void,
): () => void {
  let selected = selector(store.getState());
  return store.subscribe(() => {
    const next = selector(store.getState());
    if (!Object.is(selected, next)) {
      selected = next;
      onChange();
    }
  });
}

export function usePerpsSelector<T>(
  store: PerpsStore,
  selector: (state: PerpsState) => T,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<SelectionCache<T>>({
    hasValue: false,
    value: undefined,
  });

  const getSelection = useCallback((): T => {
    const next = selectorRef.current(store.getState());
    const cache = cacheRef.current;
    if (cache.hasValue && Object.is(cache.value, next)) {
      return cache.value as T;
    }
    cache.hasValue = true;
    cache.value = next;
    return next;
  }, [store]);

  const subscribe = useCallback(
    (onChange: () => void) =>
      subscribeWithSelector(
        store,
        (state) => selectorRef.current(state),
        onChange,
      ),
    [store],
  );

  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

export function createPerpsHooks(store: PerpsStore) {
  return {
    useStore<T>(selector: (state: PerpsState) => T): T {
      return usePerpsSelector(store, selector);
    },
    useConnection(): PerpsState["connection"] {
      return usePerpsSelector(store, (state) => state.connection);
    },
    useMarket(marketId: string) {
      return usePerpsSelector(store, (state) => state.markets[marketId] ?? null);
    },
    usePrice(marketId: string) {
      return usePerpsSelector(store, (state) => state.prices[marketId] ?? null);
    },
    useOrderbook(marketId: string) {
      return usePerpsSelector(
        store,
        (state) => state.orderbooks[marketId] ?? null,
      );
    },
    useAccount(accountId: string) {
      return usePerpsSelector(
        store,
        (state) => state.accounts[accountId] ?? null,
      );
    },
  };
}
