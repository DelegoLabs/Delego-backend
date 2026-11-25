import { describe, it, expect } from "vitest";
import {
  registerTemplate,
  getTemplate,
  getTemplateByName,
  getTemplateVersions,
  renderTemplate,
  type EmailTemplate,
} from "./templateEngine.js";

let sequence = 0;

function registerTestTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  sequence += 1;
  const name = overrides.name ?? `test-template-${sequence}`;
  const template: EmailTemplate = {
    id: `${name}:en:v1`,
    name,
    subject: "Subject {{name}}",
    htmlTemplate: "<p>{{name}}</p>",
    textTemplate: "{{name}}",
    locale: "en",
    version: 1,
    variables: [],
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  registerTemplate(template);
  return template;
}

describe("renderTemplate — variable interpolation", () => {
  it("interpolates variables in subject, html and text", () => {
    const template = registerTestTemplate({
      subject: "Approval needed for {{merchant}}",
      htmlTemplate: "<p>{{merchant}} — {{amount}} {{currency}}</p>",
      textTemplate: "{{merchant}} — {{amount}} {{currency}}",
    });

    const result = renderTemplate({
      templateId: template.id,
      variables: { merchant: "Acme", amount: "42", currency: "XLM" },
    });

    expect(result.subject).toBe("Approval needed for Acme");
    expect(result.html).toBe("<p>Acme — 42 XLM</p>");
    expect(result.text).toBe("Acme — 42 XLM");
    expect(result.warnings).toEqual([]);
  });

  it("leaves placeholders without a value intact", () => {
    const template = registerTestTemplate({
      htmlTemplate: "<p>{{known}} / {{unknown}}</p>",
    });

    const result = renderTemplate({
      templateId: template.id,
      variables: { known: "yes" },
    });

    expect(result.html).toBe("<p>yes / {{unknown}}</p>");
  });

  it("serializes object values as JSON", () => {
    const template = registerTestTemplate({
      htmlTemplate: "<p>{{payload}}</p>",
      textTemplate: "{{payload}}",
    });

    const result = renderTemplate({
      templateId: template.id,
      variables: { payload: { orderId: "ord-1" } },
    });

    expect(result.text).toBe('{"orderId":"ord-1"}');
    expect(result.html).toBe("<p>{&quot;orderId&quot;:&quot;ord-1&quot;}</p>");
  });

  it("applies defaults and warns about missing required variables", () => {
    const template = registerTestTemplate({
      htmlTemplate: "{{name}} {{locale}} {{missing}}",
      variables: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "Recipient name",
        },
        {
          name: "locale",
          type: "string",
          required: true,
          default: "en",
          description: "Locale",
        },
        {
          name: "missing",
          type: "string",
          required: true,
          description: "Required value",
        },
      ],
    });
    const variables: Record<string, unknown> = {};

    const result = renderTemplate({ templateId: template.id, variables });

    expect(result.html).toBe("{{name}} en {{missing}}");
    expect(variables.locale).toBe("en");
    expect(result.warnings).toContain("Using default value for locale");
    expect(result.warnings).toContain("Missing required variable: name");
    expect(result.warnings).toContain("Missing required variable: missing");
  });

  it("resolves conditionals and loops before interpolation", () => {
    const template = registerTestTemplate({
      htmlTemplate:
        "{{#if showItems}}<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>{{else}}No items{{/if}}",
    });

    const withItems = renderTemplate({
      templateId: template.id,
      variables: { showItems: true, items: ["one", "two"] },
    });
    const withoutItems = renderTemplate({
      templateId: template.id,
      variables: { showItems: false, items: ["one"] },
    });

    expect(withItems.html).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(withoutItems.html).toBe("No items");
  });
});

describe("renderTemplate — HTML escaping", () => {
  it("escapes interpolated values in html while keeping text and subject literal", () => {
    const template = registerTestTemplate({
      subject: "Request from {{merchant}}",
      htmlTemplate: "<p>{{merchant}}</p>",
      textTemplate: "{{merchant}}",
    });
    const merchant = `<script>alert("x") & 'y'</script>`;

    const result = renderTemplate({
      templateId: template.id,
      variables: { merchant },
    });

    expect(result.html).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;</p>"
    );
    expect(result.html).not.toContain("<script>");
    expect(result.text).toBe(merchant);
    expect(result.subject).toBe(`Request from ${merchant}`);
  });

  it("escapes values inserted into layout markup", () => {
    registerTestTemplate({
      name: "base-layout",
      htmlTemplate: "<main>{{content}}</main>",
      textTemplate: "{{content}}",
    });
    const child = registerTestTemplate({
      name: "child-page",
      layout: "base-layout",
      htmlTemplate: "<p>{{name}}</p>",
      textTemplate: "{{name}}",
    });

    const result = renderTemplate({
      templateId: child.id,
      variables: { name: "<img src=x onerror=alert(1)>" },
    });

    expect(result.html).toBe(
      "<main><p>&lt;img src=x onerror=alert(1)&gt;</p></main>"
    );
  });
});

describe("renderTemplate — missing template handling", () => {
  it("returns a structured not-found result for an unknown template id", () => {
    const result = renderTemplate({
      templateId: "does-not-exist:en:v1",
      variables: {},
    });

    expect(result).toEqual({
      subject: "Template not found",
      html: "",
      text: "",
      warnings: ["Template does-not-exist:en:v1 not found"],
    });
  });

  it("returns undefined/empty lookups for unknown templates", () => {
    expect(getTemplate("unknown:en:v1")).toBeUndefined();
    expect(getTemplateByName("unknown", "en")).toBeUndefined();
    expect(getTemplateVersions("unknown", "en")).toEqual([]);
  });

  it("falls back to English when the requested locale is unavailable", () => {
    const template = registerTestTemplate({ name: "fallback-template" });

    expect(getTemplateByName("fallback-template", "fr")?.id).toBe(template.id);
  });
});
