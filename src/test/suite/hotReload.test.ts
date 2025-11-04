import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadTemplateRecipe } from "../../templateModuleLoader";
import { renderTemplate } from "../../templateRenderer";
import type { ProcessingContext } from "../../types";

suite("Hot reload integration", () => {
  const repoRoot = path.resolve(__dirname, "../../../");
  const invoiceDir = path.join(repoRoot, "examples", "invoice");
  const templatePath = path.join(invoiceDir, "invoice.handlebars");
  const modulePath = path.join(invoiceDir, "invoice.handlebars.js");

  const context: ProcessingContext = {
    templatePath,
    modulePath,
    workspaceFolder: repoRoot,
  };

  test("uses module source override when companion document is dirty", async () => {
    const initial = await loadTemplateRecipe(modulePath, context);
    assert.ok(initial.data);
    assert.ok(Array.isArray((initial.data as { items?: unknown[] }).items));

    const overrideSource = `module.exports = () => ({
      title: "Override Title",
      data: { items: [{ name: "Dirty" }] },
      partials: {},
      helpers: {},
      watchFiles: []
    });`;

    const overridden = await loadTemplateRecipe(modulePath, context, {
      moduleSource: overrideSource,
    });

    assert.equal(overridden.title, "Override Title");
    const items = (overridden.data as { items?: Array<{ name: string }> }).items;
    assert.ok(items);
    assert.equal(items?.[0]?.name, "Dirty");
  });

  test("prefers in-memory partial source over file content", async () => {
    const partialPath = path.join(invoiceDir, "partials", "invoice-header.hbs");
    const override = "<header>Preview Override</header>";

    const recipe = await loadTemplateRecipe(modulePath, context, {
      partialSourceOverrides: {
        [partialPath]: override,
      },
    });

    assert.equal(recipe.partials.header, override);
    assert.ok(recipe.watchFiles.includes(partialPath));

    const templateSource = await fs.readFile(templatePath, "utf8");
    const rendered = await renderTemplate(templateSource, recipe, context);
    assert.ok(rendered.includes(override));
  });
});
