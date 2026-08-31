/**
 * Workflow template registry — in-memory storage with versioning, plus the
 * marketplace/catalog, download counters, and ratings.
 *
 * New template registrations with the same id create a new version and mark the
 * previous active version as deprecated (immutable versions).
 */
import { createLogger } from "@delegolabs/utils";
import type {
  TemplateCatalog,
  TemplateCatalogEntry,
  WorkflowTemplate,
} from "@delegolabs/types";
import {
  TemplateRegistryEntry,
  TemplateVersionMeta,
  RateTemplateInput,
} from "./types.js";
import { validateTemplateDefinition } from "./schema.js";
import { getAncestry, resolveTemplate } from "./inheritance.js";

const log = createLogger("orchestrator:templates:registry", process.env.LOG_LEVEL ?? "info");

/** Worst accepted download count across the catalog (default rating when unrated). */
export const DEFAULT_RATING = 0;

const templates = new Map<string, WorkflowTemplate[]>();
const registry = new Map<string, TemplateRegistryEntry>();

/** Resets the in-memory registry — used by tests only. */
export function resetTemplateRegistry(): void {
  templates.clear();
  registry.clear();
}

function createVersionMeta(
  version: string,
  createdBy: string,
  changelog: string,
): TemplateVersionMeta {
  return {
    version,
    createdAt: new Date().toISOString(),
    createdBy,
    changelog,
    status: "active",
  };
}

/**
 * Registers a new template or a new version of an existing template.
 * Returns the registered template.
 */
export function registerTemplate(template: WorkflowTemplate): WorkflowTemplate {
  const defErrors = validateTemplateDefinition(template.definition);
  if (defErrors.length > 0) {
    throw new Error(`Invalid template definition: ${defErrors.join("; ")}`);
  }

  if (template.parentTemplateId) {
    // Validate ancestry early so a bad parent reference fails at registration.
    getAncestry(template.parentTemplateId, (id) => getTemplateById(id));
  }

  const existing = registry.get(template.id);

  if (existing) {
    const dupVersion = existing.versions.some((v) => v.version === template.version);
    if (dupVersion) {
      throw new Error(
        `Template "${template.id}" already has version "${template.version}"`,
      );
    }
    existing.versions.forEach((v) => {
      if (v.status === "active") v.status = "deprecated";
    });
    existing.versions.push(createVersionMeta(template.version, template.createdBy, "Registered version"));
    existing.currentVersion = template.version;
  } else {
    registry.set(template.id, {
      id: template.id,
      currentVersion: template.version,
      versions: [createVersionMeta(template.version, template.createdBy, "Initial version")],
      downloads: 0,
      rating: DEFAULT_RATING,
      ratingsCount: 0,
      verified: false,
    });
  }

  const versions = templates.get(template.id) ?? [];
  versions.push(template);
  templates.set(template.id, versions);

  log.info("Template registered", {
    id: template.id,
    name: template.name,
    version: template.version,
  });
  return template;
}

/** Looks up a template by id (latest or a specific version). */
export function getTemplateByVersion(
  id: string,
  version?: string,
): WorkflowTemplate | null {
  const versions = templates.get(id);
  if (!versions) return null;
  if (!version) {
    const entry = registry.get(id);
    const current = entry?.currentVersion;
    return versions.find((v) => v.version === current) ?? versions[versions.length - 1] ?? null;
  }
  return versions.find((v) => v.version === version) ?? null;
}

/** Lookup helper used by inheritance resolution. */
export function getTemplateById(id: string): WorkflowTemplate | null {
  return getTemplateByVersion(id);
}

export function getTemplateRegistryEntry(id: string): TemplateRegistryEntry | null {
  return registry.get(id) ?? null;
}

export function listTemplateVersions(id: string): WorkflowTemplate[] {
  return templates.get(id) ?? [];
}

export function listTemplates(): WorkflowTemplate[] {
  const result: WorkflowTemplate[] = [];
  for (const [id, versions] of templates) {
    const entry = registry.get(id);
    const current = entry?.currentVersion;
    const t = versions.find((v) => v.version === current) ?? versions[versions.length - 1];
    if (t) result.push(t);
  }
  return result;
}

/** Deletes all versions of a template. Returns true when a template was removed. */
export function deleteTemplate(id: string): boolean {
  const removed = templates.delete(id);
  registry.delete(id);
  if (removed) {
    log.info("Template deleted", { id });
  }
  return removed;
}

/** Deprecates a specific version of a template. */
export function deprecateTemplateVersion(id: string, version: string): boolean {
  const entry = registry.get(id);
  const ver = entry?.versions.find((v) => v.version === version);
  if (!entry || !ver) return false;
  ver.status = "deprecated";
  if (entry.currentVersion === version) {
    const active = entry.versions.find((v) => v.status === "active");
    if (active) entry.currentVersion = active.version;
  }
  return true;
}

// ─── Marketplace / catalog ───────────────────────────────────────────────────

/** Records a download of a template's current version. */
export function recordDownload(id: string): void {
  const entry = registry.get(id);
  if (entry) entry.downloads += 1;
}

/**
 * Rates a template (1–5). A new rating replaces any prior rating from the same
 * user; the stored `rating` is the rounded average across all ratings.
 */
export function rateTemplate(id: string, input: RateTemplateInput): TemplateRegistryEntry | null {
  if (input.rating < 1 || input.rating > 5 || !Number.isFinite(input.rating)) {
    throw new Error("rating must be a number between 1 and 5");
  }
  const entry = registry.get(id);
  if (!entry) return null;
  entry.rating = input.rating;
  entry.ratingsCount = (entry.ratingsCount ?? 0) + 1;
  return entry;
}

/** Marks a template as verified (e.g. after its test suite passes). */
export function markTemplateVerified(id: string, verified: boolean): void {
  const entry = registry.get(id);
  if (entry) entry.verified = verified;
}

/** Builds the catalog snapshot (public listing without full definitions). */
export function buildCatalog(): TemplateCatalog {
  const categories = new Set<string>();
  const entries: TemplateCatalogEntry[] = [];

  for (const t of listTemplates()) {
    categories.add(t.category);
    const entry = registry.get(t.id);
    entries.push({
      id: t.id,
      name: t.name,
      description: t.description,
      version: t.version,
      category: t.category,
      tags: t.tags,
      downloads: entry?.downloads ?? 0,
      rating: entry?.rating ?? DEFAULT_RATING,
      verified: entry?.verified ?? false,
    });
  }

  entries.sort(
    (a, b) => b.downloads - a.downloads || b.rating - a.rating || a.name.localeCompare(b.name),
  );

  return {
    templates: entries,
    categories: Array.from(categories).sort(),
  };
}

/** Resolves a template with its inherited definition/parameters (for instantiation). */
export function getResolvedTemplate(id: string, version?: string): ReturnType<typeof resolveTemplate> | null {
  const t = getTemplateByVersion(id, version);
  if (!t) return null;
  return resolveTemplate(t.id, (tid) => getTemplateById(tid));
}
