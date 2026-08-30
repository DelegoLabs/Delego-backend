import type { IncomingMessage, ServerResponse } from "node:http";
import { checkFraudHandler, listRulesHandler, createRuleHandler, getRuleHandler, updateRuleHandler, deleteRuleHandler, evaluateRulesHandler, getModelVersionHandler, retrainModelHandler, getModelPerformanceHandler, listCasesHandler, createCaseHandler, getCaseHandler, updateCaseHandler, addEvidenceHandler, getFraudRateHandler, getFraudTrendsHandler, getTopFraudRulesHandler } from "./fraudRoutes.js";

export function registerFraudRoutes(): Array<{ method: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> {
  return [
    // Fraud check
    { method: "POST", path: "/api/v1/fraud/check", handler: checkFraudHandler },

    // Rules management
    { method: "GET", path: "/api/v1/rules", handler: listRulesHandler },
    { method: "POST", path: "/api/v1/rules", handler: createRuleHandler },
    { method: "GET", path: "/api/v1/rules/:id", handler: getRuleHandler },
    { method: "PATCH", path: "/api/v1/rules/:id", handler: updateRuleHandler },
    { method: "DELETE", path: "/api/v1/rules/:id", handler: deleteRuleHandler },
    { method: "POST", path: "/api/v1/rules/evaluate", handler: evaluateRulesHandler },

    // Model management
    { method: "GET", path: "/api/v1/model/version", handler: getModelVersionHandler },
    { method: "POST", path: "/api/v1/model/retrain", handler: retrainModelHandler },
    { method: "GET", path: "/api/v1/model/performance", handler: getModelPerformanceHandler },

    // Case management
    { method: "GET", path: "/api/v1/cases", handler: listCasesHandler },
    { method: "POST", path: "/api/v1/cases", handler: createCaseHandler },
    { method: "GET", path: "/api/v1/cases/:id", handler: getCaseHandler },
    { method: "PATCH", path: "/api/v1/cases/:id", handler: updateCaseHandler },
    { method: "POST", path: "/api/v1/cases/:id/evidence", handler: addEvidenceHandler },

    // Analytics
    { method: "GET", path: "/api/v1/analytics/fraud-rate", handler: getFraudRateHandler },
    { method: "GET", path: "/api/v1/analytics/trends", handler: getFraudTrendsHandler },
    { method: "GET", path: "/api/v1/analytics/top-fraud-rules", handler: getTopFraudRulesHandler },
  ];
}
