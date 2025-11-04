import * as fs from "node:fs/promises";
import * as path from "node:path";

import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true });
  const testsRoot = path.resolve(__dirname);
  const entries = await fs.readdir(testsRoot);

  for (const entry of entries) {
    if (!entry.endsWith(".test.js")) {
      continue;
    }
    mocha.addFile(path.resolve(testsRoot, entry));
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test${failures === 1 ? "" : "s"} failed.`));
        return;
      }
      resolve();
    });
  });
}
