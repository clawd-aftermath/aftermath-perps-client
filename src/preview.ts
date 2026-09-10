import {
  type OrderbookSimulation,
  type SimulationRequest,
  simulateOrderbook,
} from "./orderbook.js";
import type { Orderbook } from "./types.js";

export interface BackendPreviewSuccess<T> {
  readonly source: "authoritative-backend-preview";
  readonly status: "success";
  readonly data: T;
  readonly raw: unknown;
}

export interface BackendPreviewFailure {
  readonly source: "authoritative-backend-preview";
  readonly status: "error";
  readonly error: string;
  readonly raw: unknown;
}

export type BackendPreviewResult<T> = BackendPreviewSuccess<T> | BackendPreviewFailure;

export interface BackendPreviewAdapter<TRequest, TResponse> {
  preview(request: TRequest, signal?: AbortSignal): Promise<BackendPreviewResult<TResponse>>;
}

function errorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return null;
  }
  const error = value.error;
  return typeof error === "string" ? error : String(error);
}

export function createBackendPreviewAdapter<TRequest, TResponse>(
  call: (request: TRequest, signal?: AbortSignal) => Promise<TResponse>,
): BackendPreviewAdapter<TRequest, TResponse> {
  return {
    preview: async (request, signal) => {
      try {
        const response = await call(request, signal);
        const previewError = errorMessage(response);
        if (previewError !== null) {
          return {
            source: "authoritative-backend-preview",
            status: "error",
            error: previewError,
            raw: response,
          };
        }
        return {
          source: "authoritative-backend-preview",
          status: "success",
          data: response,
          raw: response,
        };
      } catch (error) {
        return {
          source: "authoritative-backend-preview",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          raw: error,
        };
      }
    },
  };
}

export interface CombinedOrderPreview<T> {
  readonly local: OrderbookSimulation;
  readonly authoritative: BackendPreviewResult<T>;
  readonly authority: {
    readonly executionEstimate: "local";
    readonly margin: "backend";
    readonly collateral: "backend";
    readonly liquidation: "backend";
    readonly validity: "backend";
  };
}

export async function previewOrder<TRequest, TResponse>(inputs: {
  readonly orderbook: Orderbook;
  readonly localRequest: SimulationRequest;
  readonly backendRequest: TRequest;
  readonly backend: BackendPreviewAdapter<TRequest, TResponse>;
  readonly signal?: AbortSignal;
}): Promise<CombinedOrderPreview<TResponse>> {
  const local = simulateOrderbook(inputs.orderbook, inputs.localRequest);
  const authoritative = await inputs.backend.preview(inputs.backendRequest, inputs.signal);
  return {
    local,
    authoritative,
    authority: {
      executionEstimate: "local",
      margin: "backend",
      collateral: "backend",
      liquidation: "backend",
      validity: "backend",
    },
  };
}

export interface SdkPreviewClient<TRequest, TResponse> {
  getPlaceMarketOrderPreview(request: TRequest, signal?: AbortSignal): Promise<TResponse>;
}

export function createAftermathSdkMarketPreviewAdapter<TRequest, TResponse>(
  client: SdkPreviewClient<TRequest, TResponse>,
): BackendPreviewAdapter<TRequest, TResponse> {
  return createBackendPreviewAdapter((request, signal) =>
    client.getPlaceMarketOrderPreview(request, signal),
  );
}
