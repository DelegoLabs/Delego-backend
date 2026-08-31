/**
 * Unit tests for the workflow template API routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../../gateway/middleware/auth.js", () => ({
  extractAuth: vi.fn(),
  getAuthenticatedUserContext: vi.fn(),
}));

import { extractAuth, getAuthenticatedUserContext } from "../../../gateway/middleware/auth.js";
import {
  resetTemplateRegistry,
  registerTemplate,
} from "./registry.js";
import {
  createTemplateHandler,
  listTemplatesHandler,
  getTemplateHandler,
  catalogHandler,
  instantiateTemplateHandler,
  rateTemplateHandler,
  testTemplateHandler,
  templateDocumentationHandler,
} from "./routes.js";
import type { WorkflowTemplate } from "@delegolabs/types";

function makeReq(url = "/api/v1/templates", body?: string): IncomingMessage {
  const req: any = new EventEmitter();
  req.headers = { host: "localhost" };
  req.url = url;
  req.method = "POST";
  if (body) {
    req.body = body;
    process.nextTick(() => {
      req.emit("data", Buffer.from(body));
      req.emit("end");
    });
  }
  return req as IncomingMessage;
}

function makeRes(): ServerResponse & { _body: any; _status: number } {
  const res: any = new EventEmitter();
  res._body = null;
  res._status = 0;
  res.statusCode = 200;
  res.setHeader = () => {};
  res.writeHead = (status: number) => { res.statusCode = status; res._status = status; };
  res.end = (chunk?: any) => {
    res._body = chunk ? JSON.parse(chunk) : null;
    res._status = res.statusCode;
  };
  return res;
}

function templatePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "Checkout",
    version: "1.0.0",
    category: "commerce",
    definition: {
      states: { A: {}, B: {} },
      transitions: [{ from: "A", on: "GO", to: "B" }],
      context: {},
    },
    parameters: [
      { name: "merchantId", type: "string", required: true, description: "" },
      { name: "amount", type: "number", required: false, default: 1, description: "" },
    ],
    ...overrides,
  });
}

function seed(): WorkflowTemplate {
  return registerTemplate({
    id: "tpl-1",
    name: "Checkout",
    description: "desc",
    version: "1.0.0",
    category: "commerce",
    tags: ["checkout"],
    definition: { states: { A: {}, B: {} }, transitions: [{ from: "A", on: "GO", to: "B" }], context: {} },
    parameters: [
      { name: "merchantId", type: "string", required: true, description: "" },
      { name: "amount", type: "number", required: false, default: 1, description: "" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: "test",
  });
}

describe("workflow template routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTemplateRegistry();
    vi.mocked(getAuthenticatedUserContext).mockReturnValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["admin"],
    });
  });

  it("createTemplateHandler: returns 401 unauthenticated", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: null, token: null });
    const res = makeRes();
    await createTemplateHandler(makeReq("/api/v1/templates", templatePayload()), res);
    expect(res.statusCode).toBe(401);
  });

  it("createTemplateHandler: returns 403 for non-admin", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    vi.mocked(getAuthenticatedUserContext).mockReturnValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["user"],
    });
    const res = makeRes();
    await createTemplateHandler(makeReq("/api/v1/templates", templatePayload()), res);
    expect(res.statusCode).toBe(403);
  });

  it("createTemplateHandler: registers a template", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    const res = makeRes();
    await createTemplateHandler(makeReq("/api/v1/templates", templatePayload()), res);
    expect(res.statusCode).toBe(201);
    expect(res._body.data.name).toBe("Checkout");
  });

  it("createTemplateHandler: rejects an invalid payload", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    const res = makeRes();
    await createTemplateHandler(makeReq("/api/v1/templates", JSON.stringify({ version: "1" })), res);
    expect(res.statusCode).toBe(400);
  });

  it("listTemplatesHandler: lists templates", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await listTemplatesHandler(makeReq("/api/v1/templates"), res);
    expect(res.statusCode).toBe(200);
    expect(res._body.data).toHaveLength(1);
  });

  it("getTemplateHandler: returns a template by id", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await getTemplateHandler(makeReq("/api/v1/templates/tpl-1"), res, { id: "tpl-1" });
    expect(res.statusCode).toBe(200);
    expect(res._body.data.template.id).toBe("tpl-1");
  });

  it("catalogHandler: returns catalog", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await catalogHandler(makeReq("/api/v1/templates/catalog"), res);
    expect(res.statusCode).toBe(200);
    expect(res._body.data.templates[0].id).toBe("tpl-1");
    expect(res._body.data.categories).toEqual(["commerce"]);
  });

  it("instantiateTemplateHandler: instantiates with parameters", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await instantiateTemplateHandler(
      makeReq("/api/v1/templates/tpl-1/instantiate", JSON.stringify({ parameters: { merchantId: "m1" } })),
      res,
      { id: "tpl-1" },
    );
    expect(res.statusCode).toBe(201);
    expect(res._body.data.workflow.templateId).toBe("tpl-1");
    expect(res._body.data.definition.context.amount).toBe(1);
  });

  it("instantiateTemplateHandler: returns 400 on missing required parameter", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await instantiateTemplateHandler(
      makeReq("/api/v1/templates/tpl-1/instantiate", JSON.stringify({ parameters: {} })),
      res,
      { id: "tpl-1" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("rateTemplateHandler: rates a template", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await rateTemplateHandler(makeReq("/api/v1/templates/tpl-1/rate", JSON.stringify({ rating: 5 })), res, {
      id: "tpl-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res._body.data.rating).toBe(5);
  });

  it("testTemplateHandler: runs the template test suite", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await testTemplateHandler(makeReq("/api/v1/templates/tpl-1/test"), res, { id: "tpl-1" });
    expect(res.statusCode).toBe(200);
    expect(res._body.data.suite.templateId).toBe("tpl-1");
  });

  it("templateDocumentationHandler: generates documentation", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
    seed();
    const res = makeRes();
    await templateDocumentationHandler(makeReq("/api/v1/templates/tpl-1/docs"), res, { id: "tpl-1" });
    expect(res.statusCode).toBe(200);
    expect(res._body.data.name).toBe("Checkout");
    expect(res._body.data.markdown).toContain("# Checkout");
  });
});
