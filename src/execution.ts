import type { PerpetualsSponsorConfig, SdkPerpetualsCancelAndPlaceOrdersInputs } from "aftermath-ts-sdk";

export type CancelAndPlaceInput = SdkPerpetualsCancelAndPlaceOrdersInputs;
export interface CancelOrdersInput {
  sponsor?: PerpetualsSponsorConfig;
  marketIdsToData: Record<string, { orderIds: bigint[]; collateralChange: number }>;
}
export interface BuiltTransaction<Transaction = unknown> {
  readonly tx: Transaction;
  readonly sponsorSignature?: string;
}
export interface AftermathAccountExecutionSource<Transaction = unknown> {
  getCancelAndPlaceOrdersTx(input: CancelAndPlaceInput): Promise<BuiltTransaction<Transaction>>;
  getCancelOrdersTx(input: CancelOrdersInput): Promise<BuiltTransaction<Transaction>>;
}
export interface TransactionExecutor<Transaction, Receipt> {
  execute(built: BuiltTransaction<Transaction>): Promise<Receipt>;
}
export interface ExecutionController<Receipt> {
  readonly inFlight: boolean;
  readonly needsReconciliation: boolean;
  replace(input: CancelAndPlaceInput): Promise<Receipt>;
  cancelOrders(input: CancelOrdersInput): Promise<Receipt>;
  acknowledgeReconciled(): void;
}

/** Create exactly one controller per account. Failed submissions latch until authoritative reconciliation. */
export function createExecutionController<Transaction, Receipt>(
  account: AftermathAccountExecutionSource<Transaction>,
  executor: TransactionExecutor<Transaction, Receipt>,
): ExecutionController<Receipt> {
  let inFlight = false;
  let needsReconciliation = false;
  const run = async (build: () => Promise<BuiltTransaction<Transaction>>): Promise<Receipt> => {
    if (inFlight) throw new Error("an account execution is already in flight");
    if (needsReconciliation) throw new Error("account state must be reconciled before another execution");
    inFlight = true;
    try {
      const built = await build();
      try {
        return await executor.execute(built);
      } catch (error) {
        needsReconciliation = true;
        throw error;
      }
    } finally {
      inFlight = false;
    }
  };
  return {
    get inFlight() { return inFlight; },
    get needsReconciliation() { return needsReconciliation; },
    replace: (input) => run(() => account.getCancelAndPlaceOrdersTx(input)),
    cancelOrders: (input) => run(() => account.getCancelOrdersTx(input)),
    acknowledgeReconciled: () => {
      if (inFlight) throw new Error("cannot acknowledge reconciliation while execution is in flight");
      needsReconciliation = false;
    },
  };
}
