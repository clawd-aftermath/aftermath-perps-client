import { createDryRunExecutor, createPerpsActions } from "../src/index.js";

const actions = createPerpsActions(
  {
    build: async (action, input) => ({
      tx: { action, input },
      sponsorSignature: "preserved-opaque-metadata",
    }),
  },
  createDryRunExecutor((built) => {
    console.log("built only", built.tx, Boolean(built.sponsorSignature));
  }),
  {
    preview: async <T>(_action: string, input: unknown) => ({
      source: "authoritative-backend-preview" as const,
      status: "success" as const,
      data: input as T,
      raw: input,
    }),
  },
);

console.log(await actions.preview("placeLimitOrder", { accountId: 1n }));
await actions.execute("placeLimitOrder", { accountId: 1n }).catch((error: unknown) =>
  console.log(error instanceof Error ? error.message : error),
);
