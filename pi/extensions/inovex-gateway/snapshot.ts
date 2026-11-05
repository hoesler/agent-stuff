/**
 * The last model list the gateway gave, kept on disk.
 *
 * pi reads models over the network once, after interactive startup, and the
 * provider has to be registered before that. Starting from the last list means
 * `/model`, `pi --list-models` and `pi -p` know the gateway's models without
 * waiting on it, and still know them offline.
 *
 * The gateway's own entries are kept, not the enriched models: the limits come
 * from pi's catalog, so a pi upgrade's newer numbers apply without a refetch.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type GatewayModel, parseGatewayModels } from "./gateway.ts";

const VERSION = 1;

/** Anything missing, unreadable or not ours reads as no models, never as a load failure. */
export function readSnapshot(path: string): GatewayModel[] {
  let stored: { version?: unknown; models?: unknown };
  try {
    stored = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (stored?.version !== VERSION || !Array.isArray(stored.models)) return [];
  // The same rules the gateway's answer is held to.
  return parseGatewayModels({
    data: stored.models.map((model: Partial<GatewayModel> | null) => ({
      id: model?.id,
      display_name: model?.name,
      owned_by: model?.ownedBy,
    })),
  });
}

/** Written aside and renamed into place, so a crash mid-write leaves the old list. */
export async function writeSnapshot(path: string, models: readonly GatewayModel[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: VERSION, models }, null, 2)}\n`);
  await rename(temporary, path);
}
