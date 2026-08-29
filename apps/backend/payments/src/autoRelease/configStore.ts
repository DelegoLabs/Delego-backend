/**
 * Per-escrow auto-release configuration store (Issue #45).
 *
 * Backed by an in-memory map by default; swap in a DB-backed implementation
 * in production via {@link setAutoReleaseConfigStore}.
 */

import type { AutoReleaseConfig } from "./types.js";
import { DEFAULT_AUTO_RELEASE_CONFIG } from "./types.js";

export interface AutoReleaseConfigStore {
  get(escrowId: string): Promise<AutoReleaseConfig>;
  set(config: AutoReleaseConfig): Promise<void>;
}

export class InMemoryAutoReleaseConfigStore implements AutoReleaseConfigStore {
  private readonly configs = new Map<string, AutoReleaseConfig>();

  async get(escrowId: string): Promise<AutoReleaseConfig> {
    return this.configs.get(escrowId) ?? { escrowId, ...DEFAULT_AUTO_RELEASE_CONFIG };
  }

  async set(config: AutoReleaseConfig): Promise<void> {
    this.configs.set(config.escrowId, config);
  }
}

let store: AutoReleaseConfigStore = new InMemoryAutoReleaseConfigStore();

export function setAutoReleaseConfigStore(newStore: AutoReleaseConfigStore): void {
  store = newStore;
}

export function resetAutoReleaseConfigStore(): void {
  store = new InMemoryAutoReleaseConfigStore();
}

export async function getAutoReleaseConfig(escrowId: string): Promise<AutoReleaseConfig> {
  return store.get(escrowId);
}

export async function setAutoReleaseConfig(config: AutoReleaseConfig): Promise<void> {
  await store.set(config);
}
