const path = require("node:path");

// Install "marked" locally (npm install marked) before opening the preview.
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
