import { json, route, type Route } from "@delegolabs/utils";
import type { IncomingMessage } from "node:http";
import type { CertificateConfig, RevocationReason } from "@delegolabs/types";
import type { CertificateService } from "../service.js";

export function registerRoutes(service: CertificateService): Route[] {
  return [
    route("GET", "/api/v1/certificates", async (_req, res) => {
      const inventory = await service.inventory();
      json(res, 200, { data: inventory, error: null });
    }),
    route("POST", "/api/v1/certificates", async (req, res) => {
      const body = await readJson<{ config: CertificateConfig; deployment?: any; autoRenew?: boolean }>(req);
      const cert = await service.issue(body.config, {
        deployment: body.deployment,
        autoRenew: body.autoRenew,
      });
      json(res, 201, { data: cert, error: null });
    }),
    route("GET", "/api/v1/certificates/:id", async (_req, res, params) => {
      const cert = await service.get(params.id);
      if (!cert) {
        json(res, 404, { data: null, error: { code: "NOT_FOUND", message: "certificate not found" } });
        return;
      }
      json(res, 200, { data: cert, error: null });
    }),
    route("POST", "/api/v1/certificates/:id/renew", async (_req, res, params) => {
      const cert = await service.renew(params.id);
      json(res, 200, { data: cert, error: null });
    }),
    route("POST", "/api/v1/certificates/:id/revoke", async (req, res, params) => {
      const body = await readJson<{ reason?: RevocationReason }>(req).catch(() => ({}) as any);
      const cert = await service.revoke(params.id, body.reason ?? "unspecified");
      json(res, 200, { data: cert, error: null });
    }),
    route("POST", "/api/v1/certificates/renewals", async (_req, res) => {
      const summary = await service.renewDueCertificates();
      json(res, 200, { data: summary, error: null });
    }),
    route("GET", "/api/v1/certificates/metrics", async (_req, res) => {
      const metrics = await service.metrics();
      json(res, 200, { data: metrics, error: null });
    }),
  ];
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}
