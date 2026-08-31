# SLO Dashboard UI Component

This document describes the SLO Dashboard UI component that provides a comprehensive view of Service Level Objectives, error budgets, and burn rates.

## Features

- Real-time SLO status for all services
- Error budget tracking with visual indicators
- Burn rate alerts (fast/slow burn)
- Service-specific dashboards
- Historical SLO reports
- Incident integration

## Dashboard Components

### 1. SLO Overview Card

```
┌─────────────────────────────────────────────────────────────────┐
│  SLO Dashboard                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Services: [Gateway] [Payments] [Wallet] [Notifications] ...  │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   Health     │  │   Burn Rate  │  │   Budget     │         │
│  │  █████████   │  │  █████████   │  │  █████████   │         │
│  │   100%       │  │   1.0x       │  │   95%        │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Service SLO Panel

```
┌─────────────────────────────────────────────────────────────────┐
│  Gateway Service                                                │
├─────────────────────────────────────────────────────────────────┤
│  Service Health: ████████████████████ 100% (Healthy)          │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Availability SLO (99.9% target)                          │  │
│  │ ████████████████████████████████ 99.95% (0.1% consumed) │  │
│  │ Burn Rate: 1.0x [━━━━━━━━━━━━━━━━━━━━]                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Latency SLO (99% target)                                 │  │
│  │ █████████████████████████████████ 99.5% (0.5% consumed) │  │
│  │ Burn Rate: 1.05x [━━━━━━━━━━━━━━━━━━━]                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Burn Rate Visualization

```
Burn Rate Scale:
   1.0x  |━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━|  6.0x
   On    |          Warning (2x)          |         Critical (6x)  |
 Budget |                                |                       |
        |                                |                       |
   [━━━━━━━━━━━━━━━━━━━━━━━━━━]         |                       |
   Current: 1.05x (Warning level)       |                       |
```

### 4. Error Budget Progress

```
Error Budget: ████████████████████████████████████████████████ 95%
Total Budget: 36.0 error-seconds/day
Consumed:    0.18 error-seconds/day
Remaining:   35.82 error-seconds/day

Burn Rate (24h): 1.05x
Time to Exhaustion: ~23 days (at current rate)
```

## Component Library

### SLOStatusIndicator

```tsx
interface SLOStatusIndicatorProps {
  status: "healthy" | "warning" | "critical" | "exhausted";
  label: string;
  value: number;
  target: number;
}

function SLOStatusIndicator({ status, label, value, target }: SLOStatusIndicatorProps) {
  const color = {
    healthy: "bg-green-500",
    warning: "bg-yellow-500",
    critical: "bg-red-500",
    exhausted: "bg-red-700",
  }[status];

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">{label}</span>
        <span className="font-medium">{(value * 100).toFixed(2)}%</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div 
          className={`h-full ${color} transition-all duration-500`}
          style={{ width: `${(value / target) * 100}%` }}
        />
      </div>
      <div className="text-xs text-gray-500">
        Target: {(target * 100).toFixed(1)}%
      </div>
    </div>
  );
}
```

### BurnRateIndicator

```tsx
interface BurnRateIndicatorProps {
  rate: number;
  warningThreshold?: number;
  criticalThreshold?: number;
  showAlert?: boolean;
}

function BurnRateIndicator({ 
  rate, 
  warningThreshold = 2,
  criticalThreshold = 6
}: BurnRateIndicatorProps) {
  const severity = 
    rate >= criticalThreshold ? "critical" :
    rate >= warningThreshold ? "warning" : "healthy";

  const colors = {
    healthy: "text-green-600 bg-green-50 border-green-200",
    warning: "text-yellow-600 bg-yellow-50 border-yellow-200",
    critical: "text-red-600 bg-red-50 border-red-200",
  };

  return (
    <div className={`px-3 py-1 rounded border ${colors[severity]} inline-flex items-center gap-2`}>
      <span className="font-medium">{rate.toFixed(2)}x</span>
      {severity !== "healthy" && (
        <span className="text-xs uppercase font-bold">{severity}</span>
      )}
    </div>
  );
}
```

### ErrorBudgetCard

```tsx
interface ErrorBudgetCardProps {
  total: number;
  consumed: number;
  remaining: number;
  burnRate: number;
  status: "healthy" | "warning" | "critical" | "exhausted";
}

function ErrorBudgetCard({ total, consumed, remaining, burnRate, status }: ErrorBudgetCardProps) {
  const percentage = (remaining / total) * 100;
  const daysToExhaustion = Math.round((remaining / consumed) * 24);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold text-gray-800 mb-4">
        Error Budget
      </h3>
      
      <div className="mb-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-gray-600">Remaining</span>
          <span className={`font-medium ${percentage < 20 ? "text-red-600" : "text-green-600"}`}>
            {percentage.toFixed(1)}%
          </span>
        </div>
        <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
          <div 
            className={`h-full ${percentage < 20 ? "bg-red-500" : "bg-green-500"} transition-all duration-500`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-2xl font-bold text-gray-800">
            {remaining.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500">Remaining</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-gray-800">
            {consumed.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500">Consumed</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-gray-800">
            {daysToExhaustion}
          </div>
          <div className="text-xs text-gray-500">Days to Exhaustion</div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-600">Burn Rate (24h)</span>
          <BurnRateIndicator rate={burnRate} />
        </div>
      </div>
    </div>
  );
}
```

### SLODashboard

```tsx
interface SLODashboardProps {
  service?: string;
  period?: { start: string; end: string };
}

function SLODashboard({ service, period }: SLODashboardProps) {
  const [sloData, setSloData] = useState<SLOMetrics | ServiceSLOMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSLOData = async () => {
      const url = service 
        ? `/api/monitoring/slo/dashboard/${service}`
        : `/api/monitoring/slo/dashboard`;
      
      const response = await fetch(url);
      const data = await response.json();
      setSloData(data.data);
      setLoading(false);
    };

    fetchSLOData();
    const interval = setInterval(fetchSLOData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [service]);

  if (loading || !sloData) {
    return <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
    </div>;
  }

  if (service) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">
            {service} Service SLOs
          </h1>
          <div className="text-sm text-gray-500">
            Last updated: {new Date(sloData.lastUpdated).toLocaleString()}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {sloData.slos.map((slo) => (
            <div key={slo.name} className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">{slo.name}</h3>
              
              <SLOStatusIndicator
                status={slo.status as any}
                label="Availability"
                value={slo.actual}
                target={slo.target}
              />

              <div className="mt-4 flex items-center justify-between">
                <span className="text-sm text-gray-600">Burn Rate</span>
                <BurnRateIndicator rate={slo.burnRate["1h"]} />
              </div>

              <div className="mt-4">
                <div className="text-xs text-gray-500 mb-1">Error Budget</div>
                <div className="flex justify-between text-sm">
                  <span>Remaining: {(slo.errorBudgetRemaining * 100).toFixed(1)}%</span>
                  <span className={slo.errorBudgetRemaining < 0.2 ? "text-red-600" : "text-green-600"}>
                    {(slo.errorBudgetRemaining * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-1">
                  <div 
                    className={`h-full ${slo.errorBudgetRemaining < 0.2 ? "bg-red-500" : "bg-green-500"}`}
                    style={{ width: `${slo.errorBudgetRemaining * 100}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {sloData.burnRateAlerts.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <h3 className="text-red-800 font-semibold mb-2">
              ⚠️ Burn Rate Alerts
            </h3>
            <ul className="space-y-2">
              {sloData.burnRateAlerts.map((alert) => (
                <li key={alert.id} className="text-red-600 text-sm">
                  {alert.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // Service overview
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">SLO Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 mb-2">Total SLOs</h3>
          <div className="text-3xl font-bold text-gray-800">
            {sloData.summary.totalSLOs}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 mb-2">Healthy</h3>
          <div className="text-3xl font-bold text-green-600">
            {sloData.summary.healthy}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 mb-2">Alerts</h3>
          <div className="text-3xl font-bold text-red-600">
            {sloData.summary.warning + sloData.summary.critical}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Service
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                SLOs
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Health
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Incidents
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sloData.services.map((service) => (
              <tr key={service.name}>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">
                    {service.name}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-500">
                    {service.slos} SLOs
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 text-xs rounded-full ${
                    service.health === "healthy" 
                      ? "bg-green-100 text-green-800"
                      : "bg-red-100 text-red-800"
                  }`}>
                    {service.health}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-500">
                    {service.incidents} active
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

## Usage Examples

### Service Overview

```tsx
import { SLODashboard } from "./slo-dashboard";

function App() {
  return (
    <div className="p-8">
      <SLODashboard />
    </div>
  );
}
```

### Service-Specific Dashboard

```tsx
import { SLODashboard } from "./slo-dashboard";

function GatewayDashboard() {
  return (
    <div className="p-8">
      <SLODashboard service="gateway" />
    </div>
  );
}
```

### Period Report

```tsx
import { SLODashboard } from "./slo-dashboard";

function WeeklyReport() {
  const period = {
    start: "2025-08-23T00:00:00Z",
    end: "2025-08-30T23:59:59Z",
  };

  return (
    <div className="p-8">
      <SLODashboard period={period} />
    </div>
  );
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/monitoring/slo/dashboard` | GET | Overall SLO status |
| `/monitoring/slo/dashboard/:service` | GET | Service-specific SLOs |
| `/monitoring/slo/report/:service` | GET | SLO report for period |
| `/monitoring/slo` | POST | Create new SLO |
| `/monitoring/slo` | GET | List all SLOs |
| `/monitoring/slo/evaluate` | POST | Evaluate SLO status |
| `/monitoring/slo/:sloId/budget` | GET | Error budget state |

## Color Scheme

- **Healthy**: Green (#10B981)
- **Warning**: Yellow (#F59E0B)
- **Critical**: Red (#EF4444)
- **Exhausted**: Dark Red (#991B1B)

## Thresholds

- **Burn Rate Warning**: 2x
- **Burn Rate Critical**: 6x
- **Error Budget Warning**: 50% consumed
- **Error Budget Critical**: 80% consumed
- **Error Budget Exhausted**: 100% consumed