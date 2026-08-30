/**
 * Integration Testing & TestContainers Types
 * Issue #86
 */

import type { User } from "./user.js";
import type { Wallet } from "./wallet.js";
import type { Delegation } from "./delegation.js";
import type { Order } from "./order.js";

export interface TestContainerConfig {
  postgres: {
    image: string;
    initScript?: string;
    username: string;
    password: string;
    database: string;
    port?: number;
  };
  redis: {
    image: string;
    port: number;
  };
  network: string;
}

export interface TestFixtures {
  createUser: (overrides?: Partial<User>) => Promise<User>;
  createWallet: (overrides?: Partial<Wallet>) => Promise<Wallet>;
  createDelegation: (overrides?: Partial<Delegation>) => Promise<Delegation>;
  createOrder: (overrides?: Partial<Order>) => Promise<Order>;
  cleanup: () => Promise<void>;
}

export interface IntegrationTestContext {
  db: unknown;
  redis: unknown;
  containers: {
    postgres: unknown;
    redis: unknown;
  };
  fixtures: TestFixtures;
}

export interface ContractTestCase {
  name: string;
  input: unknown;
  expectedStatus: number;
  expectedOutput?: unknown;
}

export interface ContractTest {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  requestSchema: object;
  responseSchema: object;
  testCases: ContractTestCase[];
}
