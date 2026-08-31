/**
 * Chaos Engineering & Resilience Types
 * Issue #90
 */

export type ChaosActionType =
  | "pod_kill"
  | "network_latency"
  | "network_loss"
  | "cpu_stress"
  | "memory_stress"
  | "dns_failure"
  | "clock_skew";

export interface ChaosExperimentMethod {
  type: ChaosActionType;
  target: string; // namespace/label selector
  config: Record<string, unknown>;
  duration: string;
}

export interface ChaosExperiment {
  name: string;
  description: string;
  hypothesis: string;
  steadyState: {
    metrics: string[];
    thresholds: Record<string, number>;
  };
  method: ChaosExperimentMethod[];
  rollback: {
    automatic: boolean;
    conditions: string[];
  };
}

export interface ChaosObservation {
  metric: string;
  expected: number;
  actual: number;
  deviation: number;
}

export interface ChaosIncident {
  type: string;
  description: string;
  severity: string;
  resolved: boolean;
}

export interface ExperimentResult {
  experiment: string;
  startTime: string;
  endTime: string;
  steadyStateMaintained: boolean;
  observations: ChaosObservation[];
  incidents: ChaosIncident[];
  conclusion: string;
}
