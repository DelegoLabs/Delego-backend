// Issue #56 — Multi-language email template engine

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@delegolabs/utils";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger("notifications:template-engine", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  htmlTemplate: string;
  textTemplate: string;
  locale: string;
  version: number;
  variables: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "date" | "object";
    required: boolean;
    default?: unknown;
    description: string;
  }>;
  layout?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRenderRequest {
  templateId: string;
  locale?: string;
  variables: Record<string, unknown>;
  preview?: boolean;
}

export interface TemplateRenderResult {
  subject: string;
  html: string;
  text: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Template store
// ---------------------------------------------------------------------------

const templates = new Map<string, EmailTemplate>();
const templateVersions = new Map<string, EmailTemplate[]>();

export function registerTemplate(template: EmailTemplate): void {
  const key = `${template.name}:${template.locale}`;
  templates.set(`${key}:v${template.version}`, template);

  const versions = templateVersions.get(key) ?? [];
  versions.push(template);
  templateVersions.set(key, versions);

  log.info("Template registered", { name: template.name, locale: template.locale, version: template.version });
}

export function getTemplate(id: string): EmailTemplate | undefined {
  return templates.get(id);
}

export function getTemplateByName(name: string, locale: string = "en"): EmailTemplate | undefined {
  const key = `${name}:${locale}`;
  const versions = templateVersions.get(key);
  if (versions && versions.length > 0) {
    return versions[versions.length - 1]; // Latest version
  }
  // Fallback to English
  if (locale !== "en") {
    return getTemplateByName(name, "en");
  }
  return undefined;
}

export function getTemplateVersions(name: string, locale: string = "en"): EmailTemplate[] {
  return templateVersions.get(`${name}:${locale}`) ?? [];
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;
const CONDITIONAL_RE = /\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
const LOOP_RE = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

export function renderTemplate(request: TemplateRenderRequest): TemplateRenderResult {
  const template = templates.get(request.templateId) ?? getTemplateByName(request.templateId, request.locale);
  const warnings: string[] = [];

  if (!template) {
    return { subject: "Template not found", html: "", text: "", warnings: [`Template ${request.templateId} not found`] };
  }

  // Validate required variables
  for (const variable of template.variables) {
    if (variable.required && !(variable.name in request.variables)) {
      if (variable.default !== undefined) {
        request.variables[variable.name] = variable.default;
        warnings.push(`Using default value for ${variable.name}`);
      } else {
        warnings.push(`Missing required variable: ${variable.name}`);
      }
    }
  }

  // Apply defaults for optional variables
  for (const variable of template.variables) {
    if (!(variable.name in request.variables) && variable.default !== undefined) {
      request.variables[variable.name] = variable.default;
    }
  }

  let html = template.htmlTemplate;
  let text = template.textTemplate;
  let subject = template.subject;

  // Process conditionals
  html = processConditionals(html, request.variables);
  text = processConditionals(text, request.variables);
  subject = processConditionals(subject, request.variables);

  // Process loops
  html = processLoops(html, request.variables);
  text = processLoops(text, request.variables);

  // Apply layout inheritance
  if (template.layout) {
    const parentTemplate = getTemplateByName(template.layout, template.locale);
    if (parentTemplate) {
      html = parentTemplate.htmlTemplate.replace(/\{\{content\}\}/g, html);
      text = parentTemplate.textTemplate.replace(/\{\{content\}\}/g, text);
    }
  }

  // Interpolate variables
  html = interpolate(html, request.variables);
  text = interpolate(text, request.variables);
  subject = interpolate(subject, request.variables);

  return { subject, html, text, warnings };
}

function processConditionals(template: string, variables: Record<string, unknown>): string {
  return template.replace(CONDITIONAL_RE, (_match, key, truthyBlock, falsyBlock) => {
    const value = variables[key];
    if (value && value !== "false" && value !== "0" && value !== "") {
      return truthyBlock;
    }
    return falsyBlock ?? "";
  });
}

function processLoops(template: string, variables: Record<string, unknown>): string {
  return template.replace(LOOP_RE, (_match, key, block) => {
    const items = variables[key];
    if (!Array.isArray(items)) return "";
    return items
      .map((item, index) => {
        let result = block;
        result = result.replace(/\{\{this\}\}/g, String(item));
        result = result.replace(/\{\{@index\}\}/g, String(index));
        if (typeof item === "object" && item !== null) {
          for (const [k, v] of Object.entries(item)) {
            result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
          }
        }
        return result;
      })
      .join("");
  });
}

function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = data[key];
    if (value === undefined) return `{{${key}}}`;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

// ---------------------------------------------------------------------------
// Template preview
// ---------------------------------------------------------------------------

export function previewTemplate(templateId: string, sampleData?: Record<string, unknown>): TemplateRenderResult {
  const data = sampleData ?? {};
  return renderTemplate({ templateId, variables: data, preview: true });
}

// ---------------------------------------------------------------------------
// Template analytics (stub)
// ---------------------------------------------------------------------------

export interface TemplateAnalytics {
  templateId: string;
  sentCount: number;
  openCount: number;
  clickCount: number;
  lastSentAt?: string;
}

const analytics = new Map<string, TemplateAnalytics>();

export function recordTemplateSent(templateId: string): void {
  const stats = analytics.get(templateId) ?? { templateId, sentCount: 0, openCount: 0, clickCount: 0 };
  stats.sentCount++;
  stats.lastSentAt = new Date().toISOString();
  analytics.set(templateId, stats);
}

export function recordTemplateOpen(templateId: string): void {
  const stats = analytics.get(templateId);
  if (stats) stats.openCount++;
}

export function recordTemplateClick(templateId: string): void {
  const stats = analytics.get(templateId);
  if (stats) stats.clickCount++;
}

export function getTemplateAnalytics(templateId: string): TemplateAnalytics | undefined {
  return analytics.get(templateId);
}

// ---------------------------------------------------------------------------
// Built-in template loader
// ---------------------------------------------------------------------------

export function loadBuiltinTemplates(): void {
  const templatesDir = resolve(__dirname, "../../templates");
  if (!existsSync(templatesDir)) return;

  const files = readdirSync(templatesDir).filter((f) => f.endsWith(".html"));
  for (const file of files) {
    const name = file.replace(".html", "");
    const html = readFileSync(join(templatesDir, file), "utf-8");
    registerTemplate({
      id: `${name}:en:v1`,
      name,
      subject: `{{subject}}`,
      htmlTemplate: html,
      textTemplate: html.replace(/<[^>]*>/g, ""),
      locale: "en",
      version: 1,
      variables: [],
      metadata: { builtin: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  log.info("Built-in templates loaded", { count: files.length });
}
