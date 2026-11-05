/**
 * The gateway's model list.
 *
 * `GET /v1/models` is a curated list, maintained by hand on the gateway side,
 * and it says nothing beyond who serves each model: no limits, no prices, no
 * capabilities. Those come from pi's catalog (see `enrich.ts`).
 */

export const GATEWAY_ORIGIN = "https://gateway.inovex.ai";

export interface GatewayModel {
  /** Exactly as the gateway lists it. The prefix is what routes, so it is never stripped for a request. */
  id: string;
  name: string;
  /** `anthropic`, `google` or `nebul` today. */
  ownedBy: string;
}

/** A failure worth telling the user about, already phrased for them. */
export class GatewayError extends Error {}

/** Accepts the gateway's `{ data: [...] }` body; anything unreadable in it is left out. */
export function parseGatewayModels(body: unknown): GatewayModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const models = new Map<string, GatewayModel>();
  for (const entry of data) {
    const { id, display_name: name, owned_by: ownedBy } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || models.has(id)) continue;
    models.set(id, {
      id,
      name: typeof name === "string" && name !== "" ? name : id,
      ownedBy: typeof ownedBy === "string" ? ownedBy : "",
    });
  }
  return [...models.values()];
}

/**
 * Reads the list with the gateway key.
 *
 * A network failure is rethrown as it is: whether it was a cancellation, which
 * stays quiet, is the caller's to decide from its own signal.
 */
export async function fetchGatewayModels(
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GatewayModel[]> {
  const response = await fetchImpl(`${GATEWAY_ORIGIN}/v1/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal,
  });

  // The key lives eight hours. A refusal is nearly always an expired one.
  if (response.status === 401 || response.status === 403) {
    throw new GatewayError(
      `the gateway refused the key (${response.status}); it has probably expired — renew it with synapse auth`,
    );
  }
  if (!response.ok) {
    throw new GatewayError(`/v1/models answered ${response.status} ${response.statusText}`.trimEnd());
  }

  const models = parseGatewayModels(await response.json());
  if (models.length === 0) throw new GatewayError("/v1/models listed no models");
  return models;
}
