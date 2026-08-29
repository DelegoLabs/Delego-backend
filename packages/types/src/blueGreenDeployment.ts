/**
 * Blue-green deployment types (Issue #93).
 */

export type DeploymentColor = "blue" | "green";

export interface BlueGreenConfig {
  namespace: string;
  blueDeployment: string;
  greenDeployment: string;
  service: string;
  ingress: string;
  healthCheckPath: string;
  healthCheckIntervalSeconds: number;
  healthCheckTimeoutSeconds: number;
  switchTimeoutSeconds: number;
}

export interface TrafficSplit {
  blue: number;
  green: number;
}

export interface DeploymentState {
  activeColor: DeploymentColor;
  blueVersion: string;
  greenVersion: string;
  blueReplicas: number;
  greenReplicas: number;
  trafficSplit: TrafficSplit;
  lastSwitchAt: string;
}

export interface SwitchResult {
  fromColor: DeploymentColor;
  toColor: DeploymentColor;
  version: string;
  success: boolean;
  durationMs: number;
  healthChecksPassed: boolean;
  rollbackTriggered: boolean;
}
