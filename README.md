# Handlebars Preview Plus

Render Handlebars templates directly inside VS Code. Every `.hbs` or `.handlebars` file can be paired with an optional JavaScript or TypeScript module whose filename is the template filename plus `.js` or `.ts`; that module prepares input data, registers helpers/partials, and can perform optional pre/post processing before the preview updates.

![Handlebars Preview Plus demo](./showcase.webp)

## Feature Highlights

- Live webview preview that tracks the template, companion module, and any extra files you opt into.
- Companion modules can return async data, register helpers/partials, and transform the source before or after rendering.
- File-backed partials reload instantly—even when the partial is unsaved but open in the editor.
- Manual refresh command for long-running tasks or external side effects.
- Preview still renders if you skip the companion module, using the raw template with empty data by default.
- Supports `.hbs.js` and `.hbs.ts` companions—TypeScript modules compile using your workspace `tsconfig.json`.
- TypeScript companions can import other `.ts` files in your workspace; the extension transpiles dependencies on demand, tracks the dependency graph, and hot-reloads unsaved edits.
- TypeScript companions can require packages from your workspace `node_modules`, relying on the same resolution rules as your project.

## Quick Start

1. Open a Handlebars template such as `email.hbs` in VS Code.
2. (Optional) Create a companion module named `email.hbs.js` or `email.hbs.ts` (append `.js` or `.ts` to the full template filename).
3. Export either an object or a function from the module; return the configuration described below.
4. Run **Handlebars Preview Plus: Open Handlebars Preview Plus** from the command palette, the editor title bar, or the Explorer context menu.

### Minimal TypeScript example

`email.hbs`

```hbs
<h1>{{title}}</h1>
<p>Hello {{recipient.firstName}}!</p>
```

`email.hbs.ts`

```ts
type Recipient = {
  firstName: string;
};

interface EmailContext {
  title: string;
  recipient: Recipient;
}

export default function buildEmail() {
  const data: EmailContext = {
    title: "Welcome",
    recipient: { firstName: "Ada" },
  };

  return {
    title: "Sample Email",
    data,
  };
}
```

The module’s default export can return the preview recipe object directly. The TypeScript compiler settings come from the nearest `tsconfig.json` in your workspace, and the extension forces CommonJS output under the hood.

### Minimal JavaScript example

`email.hbs.js`

```js
module.exports = () => ({
  title: "Sample Email",
  data: {
    title: "Welcome",
    recipient: { firstName: "Ada" },
  },
});
```

### Configuration fields

- `title` _(string)_ – optional webview title override.
- `data` _(object | function)_ – return the template data directly or via a function that receives `{ templatePath, modulePath, workspaceFolder }`.
- `helpers` _(record)_ – helper functions keyed by name.
- `partials` _(record)_ – inline strings or `{ file: "./partial.hbs", encoding?: "utf8" }`. File paths are resolved relative to the companion module and are watched automatically.
- `preprocess` / `postprocess` _(function)_ – transform the template source or rendered HTML.
- `watchFiles` _(string[] | function)_ – extra files or globs to watch in addition to the template/module/partials.

The companion module can be nested (default export, factory functions, etc.); the loader resolves down to the first object shape containing these fields.

## Advanced Recipes

### Markdown helper + layout partial

`newsletter.hbs`

```hbs
<header>
  <h1>{{subject}}</h1>
</header>

{{!-- markdown block renders tables and bullet lists --}}
{{#markdown}}
  # Weekly Digest

  {{#each highlights}}
    - **{{title}}** — {{summary}}
  {{/each}}

  {{#if isActive}}
    > The account is active.
  {{else}}
    > The account is not active.
  {{/if}}
{{/markdown}}

<section>
  {{!-- complex table rendered via markdown helper --}}
  {{#markdown}}
    ### Product List

    | Name | Price | Features |
    | ---- | ----- | -------- |
    {{#each products}}
    | {{name}} | {{price}} | {{features.join(", ")}} |
    {{/each}}
  {{/markdown}}
</section>
```

`newsletter.hbs.js`

```js
const path = require("node:path");

let markedPromise;
const getMarked = async () => {
  if (!markedPromise) {
    markedPromise = import("marked").then(({ marked }) => {
      marked.use({
        gfm: true,
        mangle: false,
        headerIds: false,
        renderer: {
          paragraph(text) {
            if (typeof text !== "string") {
              return `<p>${text}</p>\n`;
            }
            return text.includes("{{") ? `${text}\n` : `<p>${text}</p>\n`;
          },
        },
      });
      return marked;
    });
  }
  return markedPromise;
};

module.exports = async ({ workspaceFolder }) => {
  const marked = await getMarked();

  return {
    data: {
      subject: "March Newsletter",
      highlights: [
        { title: "Item 1", summary: "Fresh content" },
        { title: "Item 2", summary: "New features" },
        { title: "Item 3", summary: "Upcoming events" },
      ],
      products: [
        { name: "Product 1", price: "$10", features: ["Feature A", "Feature B"] },
        { name: "Product 2", price: "$20", features: ["Feature C", "Feature D"] },
      ],
      isActive: true,
    },
    preprocess: (source) => `{{#> layout }}\n${source}\n{{/layout}}`,
    helpers: {
      markdown(options) {
        const raw = options.fn(this);
        const lines = raw.split("\n");
        const indents = lines
          .filter((line) => line.trim().length)
          .map((line) => line.match(/^\s*/)[0].length);
        const minIndent = indents.length ? Math.min(...indents) : 0;
        const dedented = lines
          .map((line) => line.slice(Math.min(line.length, minIndent)))
          .join("\n")
          .trim();
        return marked.parse(dedented);
      },
    },
    partials: {
      layout: { file: path.join(workspaceFolder, "template.partial.hbs") },
    },
  };
};
```

Install `marked` in your workspace (`npm install marked`) before using this sample live.

`template.partial.hbs`

```hbs
<!DOCTYPE html>
<html>
  <body>
    <main>
      {{{> @partial-block}}}
    </main>
  </body>
</html>
```

This combination demonstrates:

- Async helper setup (`marked`) with cached dynamic imports.
- Dedenting markdown blocks before parsing so triple-stash HTML works.
- Preprocessing the template to project its body into a Handlebars layout partial via `{{#> layout}}`.
- File-backed partial paths resolved from the module and watched automatically—edits to `template.partial.hbs` update the preview without saving.

### API-backed invoice with shared partials

`invoice.handlebars`

```hbs
{{> header}}

<section class="line-items">
  {{#each items}}
    <article>
      <h2>{{name}}</h2>
      <p>{{description}}</p>
      <strong>{{formatPrice total}}</strong>
    </article>
  {{/each}}
</section>

{{> footer}}
```

`invoice.handlebars.js`

```js
const path = require("node:path");
const fs = require("node:fs/promises");

module.exports = async ({ modulePath }) => {
  const apiResponse = await fs.readFile(
    path.join(path.dirname(modulePath), "mock-api.json"),
    "utf8"
  );
  const invoice = JSON.parse(apiResponse);

  return {
    title: `Invoice #${invoice.number}`,
    data: invoice,
    helpers: {
      formatPrice(value) {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: invoice.currency ?? "USD",
        }).format(value);
      },
    },
    partials: {
      header: { file: "./partials/invoice-header.hbs" },
      footer: { file: "./partials/invoice-footer.hbs" },
    },
    watchFiles: ["./mock-api.json"],
  };
};
```

Any time you edit `mock-api.json`, either partial, or the main template, the preview re-renders automatically. Unsaved edits in these files also flow through thanks to the extension’s in-memory overrides.

## Examples

Ready-to-run sample projects live in `examples/`:

- `examples/newsletter/` mirrors the markdown helper + layout partial walkthrough (install `marked` locally to render markdown).
- `examples/invoice/` shows an API-backed invoice with shared partials and a watched JSON payload.
- `examples/typescript/` demonstrates a `.hbs.ts` companion module compiled with the workspace TypeScript configuration.
- `examples/typescript-relative/` imports a sibling TypeScript helper, showcasing cross-file TypeScript dependency support without a build step.
- `examples/typescript-node-module/` loads a helper from `node_modules`, verifying that workspace dependencies are available to companions during preview and are watched for changes.

Open any template from those folders and run **Handlebars Preview Plus: Open Handlebars Preview Plus** to explore the features.

## Commands

- `Handlebars Preview Plus: Open Handlebars Preview Plus` – render the active template or a selected file.
- `Handlebars Preview Plus: Refresh Handlebars Preview Plus` – force a re-render of the active preview.

Commands are also available from the editor title menu, editor context menu, and Explorer context menu for `.hbs`/`.handlebars` files.

## Tips & Limitations

- Companion modules must be CommonJS (`module.exports`). If you author in ESM, export a CJS bridge.
- The preview webview uses a restrictive CSP: network requests are blocked except for images/fonts. Inline styles and scripts are allowed.
- When you watch files outside the workspace, the extension falls back to `fs.watch`; behavior varies by platform.
- Large helper dependencies (like `marked`) are fine—just import lazily as shown above so cold starts stay fast.
- Use `watchFiles` when external processes (e.g., build step producing JSON) should trigger preview refreshes.
- Toggle `handlebars-preview-plus.enableDebugLogging` for verbose output in the “Handlebars Preview Plus” output channel when debugging watcher behaviour.
- TypeScript companions follow the nearest `tsconfig.json`; ensure project settings emit CommonJS-friendly code (the extension forces `module: commonjs`).
- Relative TypeScript imports do not require a bundler—the extension resolves and transpiles `.ts` dependencies automatically during preview.
- Bare specifiers (`import x from "some-package"`) resolve the same way as your project does, including support for workspace `node_modules`.
- Imported TypeScript helpers (and workspace packages pulling in `.ts` sources) are watched automatically, so unsaved edits in those files immediately trigger preview refreshes.

## Credits

Every line of this extension—including source code, tests, documentation, and configuration—was generated with GitHub Copilot Chat (GPT-5 Codex).

## Changelog

### 0.0.3 · 2025-11-12

- Companion module now optional—templates render even when no `.hbs.js`/`.hbs.ts` file exists.
- TypeScript companions load through the workspace `tsconfig.json`, unlocking `.hbs.ts` files.
- Relative TypeScript helpers are compiled on demand, so companions can import local `.ts` utilities without a build step.
- TypeScript companions can import packages from `node_modules`, mirroring project module resolution during preview.
- Added optional debug logging, new `examples/` recipes (newsletter, invoice, TypeScript), and corresponding automated tests.
- CI pipeline now runs lint, compile, and test on every push and pull request.

### 0.0.2 · 2025-11-04

- Refreshed documentation and screenshots ahead of the 0.0.2 marketplace publish.

### 0.0.1 · 2025-11-04

- Initial preview implementation with companion data modules, helper/partial support (including file-backed partials), preprocess/postprocess hooks, live partial watching, and manual refresh.

## License

Distributed under the MIT License. See `LICENSE` for details.
