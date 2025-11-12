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
  const tsDir = path.join(repoRoot, "examples", "typescript");
  const tsTemplatePath = path.join(tsDir, "sample.hbs");
  const tsModulePath = path.join(tsDir, "sample.hbs.ts");
  const tsRelativeDir = path.join(
    repoRoot,
    "examples",
    "typescript-relative",
    "templates",
    "nested"
  );
  const tsRelativeTemplatePath = path.join(tsRelativeDir, "email.hbs");
  const tsRelativeModulePath = path.join(tsRelativeDir, "email.hbs.ts");
  const tsRelativeHelperPath = path.join(
    repoRoot,
    "examples",
    "typescript-relative",
    "sanitizeEmailHtml.ts"
  );
  const tsNodeModuleDir = path.join(
    repoRoot,
    "examples",
    "typescript-node-module",
    "templates"
  );
  const tsNodeModuleTemplatePath = path.join(tsNodeModuleDir, "email.hbs");
  const tsNodeModuleModulePath = path.join(tsNodeModuleDir, "email.hbs.ts");

  const context: ProcessingContext = {
    templatePath,
    modulePath,
    workspaceFolder: repoRoot,
  };

  const tsContext: ProcessingContext = {
    templatePath: tsTemplatePath,
    modulePath: tsModulePath,
    workspaceFolder: repoRoot,
  };

  const tsRelativeContext: ProcessingContext = {
    templatePath: tsRelativeTemplatePath,
    modulePath: tsRelativeModulePath,
    workspaceFolder: repoRoot,
  };

  const tsNodeModuleContext: ProcessingContext = {
    templatePath: tsNodeModuleTemplatePath,
    modulePath: tsNodeModuleModulePath,
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

  test("loads TypeScript companion module with workspace tsconfig", async () => {
    const recipe = await loadTemplateRecipe(tsModulePath, tsContext);
    const templateSource = await fs.readFile(tsTemplatePath, "utf8");
    const rendered = await renderTemplate(templateSource, recipe, tsContext);
    assert.ok(rendered.includes("TypeScript Companion Module"));
  });

  test("applies TypeScript module overrides", async () => {
    const overrideSource = `type Message = { title: string; message: string };
export default function overridePreview() {
  const data: Message = { title: "TS Override", message: "Dirty override" };
  return { data };
}`;

    const recipe = await loadTemplateRecipe(tsModulePath, tsContext, {
      moduleSource: overrideSource,
    });

    const data = recipe.data as { title?: string; message?: string };
    assert.equal(data.title, "TS Override");
    assert.equal(data.message, "Dirty override");
  });

  test("resolves relative TypeScript dependencies", async () => {
    const recipe = await loadTemplateRecipe(
      tsRelativeModulePath,
      tsRelativeContext
    );

    const templateSource = await fs.readFile(
      tsRelativeTemplatePath,
      "utf8"
    );
    const rendered = await renderTemplate(
      templateSource,
      recipe,
      tsRelativeContext
    );

    assert.ok(rendered.includes("::sanitized::"));
    assert.ok(
      recipe.moduleDependencies.some(
        (dependency) =>
          path.normalize(dependency) === path.normalize(tsRelativeHelperPath)
      )
    );
  });

  test("resolves node_module dependencies from TypeScript companions", async () => {
    const recipe = await loadTemplateRecipe(
      tsNodeModuleModulePath,
      tsNodeModuleContext
    );

    const templateSource = await fs.readFile(
      tsNodeModuleTemplatePath,
      "utf8"
    );
    const rendered = await renderTemplate(
      templateSource,
      recipe,
      tsNodeModuleContext
    );

    assert.ok(rendered.includes("::example-sanitized::"));
  });
});
