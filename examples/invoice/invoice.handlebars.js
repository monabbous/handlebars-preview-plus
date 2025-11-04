const path = require("node:path");
const fs = require("node:fs/promises");

module.exports = async ({ modulePath }) => {
  const apiResponse = await fs.readFile(
    path.join(path.dirname(modulePath), "mock-api.json"),
    "utf8"
  );
  const invoice = JSON.parse(apiResponse);
  invoice.total = Array.isArray(invoice.items)
    ? invoice.items.reduce((acc, item) => acc + Number(item.total ?? 0), 0)
    : 0;

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
