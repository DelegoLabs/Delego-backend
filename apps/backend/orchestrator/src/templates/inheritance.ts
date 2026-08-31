/**
 * Template inheritance — a template may declare `parentTemplateId`. When resolved,
 * the child inherits the parent's states, transitions, and parameter declarations,
 * and can override/extend them. This reduces duplication across templates that
 * share a common base flow.
 *
 * The registry provides the parent lookup; this module performs the merge.
 */
import type {
  WorkflowTemplate,
  WorkflowTemplateDefinition,
  WorkflowTemplateParameter,
} from "@delegolabs/types";
import type { ResolvedTemplate } from "./types.js";

/** Thrown when a template's parent chain is missing or contains a cycle. */
export class TemplateInheritanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateInheritanceError";
  }
}

/**
 * Walks a template's parent chain and returns the ordered list of ancestors from
 * the root-most template down to the immediate parent. Throws on cycles or a
 * missing parent.
 *
 * @param templateId  The template whose ancestry is requested.
 * @param getById     Lookup a template by id (used by the registry).
 */
export function getAncestry(
  templateId: string,
  getById: (id: string) => WorkflowTemplate | null,
): WorkflowTemplate[] {
  const chain: WorkflowTemplate[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = templateId;

  while (currentId) {
    if (visited.has(currentId)) {
      throw new TemplateInheritanceError(
        `Circular template inheritance detected involving "${currentId}"`,
      );
    }
    visited.add(currentId);

    const current = getById(currentId);
    if (!current) {
      throw new TemplateInheritanceError(
        `Parent template "${currentId}" not found for template "${chain.length ? chain[chain.length - 1].id : templateId}"`,
      );
    }
    chain.push(current);
    currentId = current.parentTemplateId;
  }

  // Reverse so the root-most ancestor is first.
  return chain.reverse();
}

/**
 * Merges parent + child definitions. Child states override same-named parent
 * states; child transitions are appended to the parent's. Child context is
 * merged over the parent context.
 */
function mergeDefinition(
  parent: WorkflowTemplateDefinition | undefined,
  child: WorkflowTemplateDefinition,
): WorkflowTemplateDefinition {
  if (!parent) return child;

  return {
    states: {
      ...(parent.states ?? {}),
      ...(child.states ?? {}),
    },
    transitions: [...(parent.transitions ?? []), ...(child.transitions ?? [])],
    context: {
      ...(parent.context ?? {}),
      ...(child.context ?? {}),
    },
  };
}

/**
 * Merges parent + child parameters. A child parameter overrides the parent's
 * declaration when it shares a name; otherwise child parameters are appended
 * after the parent's. Optional parameters inherited from a parent are allowed to
 * remain optional regardless of the child's `required` flag (the child may only
 * flip non-inherited required flags).
 */
function mergeParameters(
  parent: WorkflowTemplateParameter[] | undefined,
  child: WorkflowTemplateParameter[],
): WorkflowTemplateParameter[] {
  if (!parent) return child;

  const merged = new Map<string, WorkflowTemplateParameter>();
  for (const p of parent) merged.set(p.name, p);
  for (const p of child) {
    const existing = merged.get(p.name);
    if (existing) {
      merged.set(p.name, { ...existing, ...p });
    } else {
      merged.set(p.name, p);
    }
  }
  return Array.from(merged.values());
}

/**
 * Resolves a template into its fully merged form, applying inheritance.
 *
 * @param templateId  The template (or child template) to resolve.
 * @param getById     Lookup a template by id (used by the registry).
 * @returns          The resolved template with merged definition and parameters.
 */
export function resolveTemplate(
  templateId: string,
  getById: (id: string) => WorkflowTemplate | null,
): ResolvedTemplate {
  const ancestry = getAncestry(templateId, getById);
  const leaf = ancestry[ancestry.length - 1];
  const parents = ancestry.slice(0, -1);

  let definition: WorkflowTemplateDefinition | undefined;
  let parameters: WorkflowTemplateParameter[] | undefined;

  for (const ancestor of parents) {
    definition = definition ? mergeDefinition(definition, ancestor.definition) : ancestor.definition;
    parameters = parameters
      ? mergeParameters(parameters, ancestor.parameters ?? [])
      : (ancestor.parameters ?? []);
  }

  definition = definition ? mergeDefinition(definition, leaf.definition) : leaf.definition;
  parameters = parameters
    ? mergeParameters(parameters, leaf.parameters ?? [])
    : (leaf.parameters ?? []);

  const tags = Array.from(new Set(parents.flatMap((p) => p.tags ?? []).concat(leaf.tags ?? [])));

  return {
    templateId: leaf.id,
    name: leaf.name,
    description: leaf.description,
    version: leaf.version,
    category: leaf.category,
    tags,
    definition,
    parameters,
    parentTemplateId: leaf.parentTemplateId,
  };
}
