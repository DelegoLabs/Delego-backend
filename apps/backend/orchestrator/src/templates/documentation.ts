/**
 * Template documentation generator — produces human-readable Markdown
 * documentation from a (resolved) template: overview, parameters, states,
 * transitions, inherited ancestry, and instantiation examples.
 */
import { TemplateDocumentation, TemplateDocSection } from "./types.js";
import { getResolvedTemplate, getTemplateByVersion } from "./registry.js";
import { getAncestry } from "./inheritance.js";

/** Returns the Markdown documentation block for a template (or specific version). */
export function generateTemplateDocumentation(
  templateId: string,
  version?: string,
): TemplateDocumentation {
  const template = getTemplateByVersion(templateId, version);
  if (!template) {
    throw new Error(`Template "${templateId}" not found`);
  }

  const resolved = getResolvedTemplate(templateId, version)!;
  const sections: TemplateDocSection[] = [];

  // ── Overview ────────────────────────────────────────────────────────────────
  const overview = [
    `# ${template.name}`,
    ``,
    `${template.description || "No description provided."}`,
    ``,
    `- **ID:** \`${template.id}\``,
    `- **Version:** \`${template.version}\``,
    `- **Category:** ${template.category}`,
    `- **Tags:** ${template.tags.length ? template.tags.map((t) => `\`${t}\``).join(", ") : "—"}`,
  ];
  if (template.parentTemplateId) {
    const ancestry = getAncestry(template.id, (id) => getTemplateByVersion(id));
    overview.push(
      ``,
      `- **Parent:** ${template.parentTemplateId}`,
      `- **Ancestry:** ${ancestry.map((a) => `\`${a.name}\``).join(" → ")}`,
    );
  }
  sections.push({ title: "Overview", body: overview.join("\n") });

  // ── Parameters ──────────────────────────────────────────────────────────────
  const paramsLines = [
    `| Parameter | Type | Required | Default | Description |`,
    `|-----------|------|----------|---------|-------------|`,
  ];
  for (const p of resolved.parameters) {
    const def = p.default === undefined ? "—" : "`" + JSON.stringify(p.default) + "`";
    paramsLines.push(
      `| \`${p.name}\` | \`${p.type}\` | ${p.required ? "yes" : "no"} | ${def} | ${p.description}` +
        (p.validation ? ` *(schema: \`${p.validation.replace(/\n/g, " ")}\`)*` : "") +
        ` |`,
    );
  }
  sections.push({
    title: "Parameters",
    body: paramsLines.join("\n"),
  });

  // ── States ──────────────────────────────────────────────────────────────────
  const statesLines = [`| State |` + ` Description |`, `|-------|--------------|`];
  for (const [state, meta] of Object.entries(resolved.definition.states ?? {})) {
    const desc =
      typeof meta === "object" && meta !== null && "description" in meta
        ? String((meta as { description: unknown }).description ?? "")
        : "—";
    statesLines.push(`| \`${state}\` | ${desc} |`);
  }
  sections.push({ title: "States", body: statesLines.join("\n") });

  // ── Transitions ─────────────────────────────────────────────────────────────
  const transitions =
    (resolved.definition.transitions ?? [])
      .map((t) => {
        if (typeof t === "object" && t !== null) {
          const rec = t as Record<string, unknown>;
          return `- \`${String(rec.from ?? "?")}\` --${String(rec.on ?? rec.event ?? "?")}--> \`${String(rec.to ?? "?")}\``;
        }
        return `- ${JSON.stringify(t)}`;
      })
      .join("\n") || "_No transitions declared._";
  sections.push({ title: "Transitions", body: transitions });

  // ── Instantiation example ───────────────────────────────────────────────────
  const exampleParams: Record<string, unknown> = {};
  for (const p of resolved.parameters) {
    if (p.default !== undefined) {
      exampleParams[p.name] = p.default;
    } else {
      exampleParams[p.name] = exampleValue(p.type);
    }
  }
  const example = [
    "```json",
    JSON.stringify(
      {
        templateId: template.id,
        templateVersion: template.version,
        parameters: exampleParams,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
  sections.push({ title: "Instantiation Example", body: example });

  const markdown = sections
    .map((s) => (s.title === "Overview" ? s.body : `## ${s.title}\n\n${s.body}`))
    .join("\n\n---\n\n");

  return {
    templateId: template.id,
    name: template.name,
    version: template.version,
    generatedAt: new Date().toISOString(),
    markdown,
    sections,
  };
}

function exampleValue(type: string): unknown {
  switch (type) {
    case "string":
      return "example";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    case "array":
      return [];
    default:
      return "example";
  }
}

/** Convenience: returns just the raw Markdown string. */
export function renderTemplateDocumentation(
  templateId: string,
  version?: string,
): string {
  return generateTemplateDocumentation(templateId, version).markdown;
}
