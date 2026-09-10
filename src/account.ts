import type { BuiltTransaction, TransactionExecutor } from "./execution.js";
import type { BackendPreviewResult } from "./preview.js";

/** The backend requires this exact statement; callers cannot substitute UI copy. */
export const AFTERMATH_TERMS_AND_CONDITIONS = "Aftermath Terms and Conditions" as const;
export type AccountId = bigint;
export type ObjectId = string;

export function accountIdWire(accountId: AccountId): `${bigint}n` {
  if (accountId < 0n) throw new RangeError("accountId must be non-negative");
  return `${accountId}n`;
}

export interface TermsAuthenticator {
  authenticate(message: typeof AFTERMATH_TERMS_AND_CONDITIONS): Promise<{ readonly bytes: string; readonly signature: string }>;
}
export async function authenticateAftermathTerms(authenticator: TermsAuthenticator): Promise<{ readonly bytes: string; readonly signature: string }> {
  return authenticator.authenticate(AFTERMATH_TERMS_AND_CONDITIONS);
}

export function createAuthenticatedUserSubscription(input: {
  readonly accountId: AccountId;
  readonly walletAddress: string;
  readonly authentication: { readonly bytes: string; readonly signature: string };
}) {
  accountIdWire(input.accountId);
  return { user: { accountId: input.accountId, withStopOrders: { walletAddress: input.walletAddress, ...input.authentication } } } as const;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasNextPage: boolean;
}
export interface CursorPageSource<T> {
  fetchPage(input: { readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<CursorPage<T>>;
}
export async function* paginateCursor<T>(
  source: CursorPageSource<T>,
  options: { readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal } = {},
): AsyncGenerator<CursorPage<T>, void> {
  let cursor = options.cursor;
  const seen = new Set<string>();
  while (true) {
    const input: { cursor?: string; limit?: number; signal?: AbortSignal } = {};
    if (cursor !== undefined) input.cursor = cursor;
    if (options.limit !== undefined) input.limit = options.limit;
    if (options.signal !== undefined) input.signal = options.signal;
    const page = await source.fetchPage(input);
    yield page;
    if (!page.hasNextPage || page.nextCursor === null) return;
    if (seen.has(page.nextCursor)) throw new Error("cursor pagination cycle detected");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export interface SponsoredBuild<Transaction> extends BuiltTransaction<Transaction> {
  readonly sponsorSignature?: string;
}

export type PerpsAction =
  | "createAccount" | "depositCollateral" | "withdrawCollateral"
  | "placeMarketOrder" | "placeLimitOrder" | "placeScaleOrders"
  | "cancelOrders" | "setLeverage" | "placeStopOrder" | "placeSltp"
  | "placeTwapOrder" | "cancelTwapOrder" | "createAgentWallet"
  | "revokeAgentWallet";

export interface PerpsTransactionBuilder<Transaction> {
  build(action: PerpsAction, input: unknown): Promise<SponsoredBuild<Transaction>>;
}
export interface PerpsPreviewer {
  preview<T>(action: PerpsAction, input: unknown, signal?: AbortSignal): Promise<BackendPreviewResult<T>>;
}
export interface PerpsActions<Receipt> {
  readonly inFlight: boolean;
  readonly needsReconciliation: boolean;
  preview<T>(action: PerpsAction, input: unknown, signal?: AbortSignal): Promise<BackendPreviewResult<T>>;
  execute(action: PerpsAction, input: unknown): Promise<Receipt>;
  acknowledgeReconciled(): void;
}

/**
 * Keeps construction, signing/submission, and API state separate. The executor
 * receives the complete built value so sponsorship metadata is never dropped.
 */
export function createPerpsActions<Transaction, Receipt>(
  builder: PerpsTransactionBuilder<Transaction>,
  executor: TransactionExecutor<Transaction, Receipt>,
  previewer: PerpsPreviewer,
): PerpsActions<Receipt> {
  let inFlight = false;
  let needsReconciliation = false;
  return {
    get inFlight() { return inFlight; },
    get needsReconciliation() { return needsReconciliation; },
    preview: (action, input, signal) => previewer.preview(action, input, signal),
    execute: async (action, input) => {
      if (inFlight) throw new Error("an account transaction is already in flight");
      if (needsReconciliation) throw new Error("account state must be reconciled before another transaction");
      inFlight = true;
      try {
        const built = await builder.build(action, input);
        try {
          return await executor.execute(built);
        } catch (error) {
          needsReconciliation = true;
          throw error;
        }
      } finally {
        inFlight = false;
      }
    },
    acknowledgeReconciled: () => {
      if (inFlight) throw new Error("cannot acknowledge reconciliation while a transaction is in flight");
      needsReconciliation = false;
    },
  };
}

export interface DryRunExecutor<Transaction> extends TransactionExecutor<Transaction, never> {}
export function createDryRunExecutor<Transaction>(
  inspect: (built: BuiltTransaction<Transaction>) => void = () => undefined,
): DryRunExecutor<Transaction> {
  return {
    execute: async (built) => {
      inspect(built);
      throw new Error("dry-run executor: transaction was built but not signed or submitted");
    },
  };
}
