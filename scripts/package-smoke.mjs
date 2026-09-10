import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "aftermath-perps-client-smoke-"),
);
let tarball = null;

try {
  rmSync(join(projectRoot, "aftermath-perps-client-0.1.0.tgz"), {
    force: true,
  });
  execFileSync("npm", ["run", "build"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );
  const packed = JSON.parse(packOutput);
  if (!Array.isArray(packed) || typeof packed[0]?.filename !== "string") {
    throw new Error("npm pack did not return a tarball filename");
  }

  tarball = join(projectRoot, packed[0].filename);
  writeFileSync(
    join(temporaryRoot, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", tarball, "react@19.1.1"],
    {
      cwd: temporaryRoot,
      stdio: "inherit",
    },
  );

  writeFileSync(
    join(temporaryRoot, "smoke.mjs"),
    `import * as core from "aftermath-perps-client";
import * as aftermath from "aftermath-perps-client/aftermath";
import * as react from "aftermath-perps-client/react";

const checks = [
  typeof core.createPerpsStore,
  typeof core.simulateOrderbook,
  typeof core.createExecutionController,
  typeof core.planQuoteCycle,
  typeof aftermath.createAftermathNativeSnapshotSource,
  typeof aftermath.createAftermathWebSocketStream,
  typeof react.createPerpsHooks,
];
if (checks.some((value) => value !== "function")) {
  throw new Error("One or more package exports are missing");
}
console.log("package export smoke test passed");`,
  );
  execFileSync("node", [join(temporaryRoot, "smoke.mjs")], {
    cwd: temporaryRoot,
    stdio: "inherit",
  });

  const manifest = JSON.parse(
    readFileSync(
      join(
        temporaryRoot,
        "node_modules/aftermath-perps-client/package.json",
      ),
    ),
  );
  if (manifest.version !== "0.1.0") {
    throw new Error(`Unexpected installed version: ${manifest.version}`);
  }
} finally {
  if (tarball !== null) {
    rmSync(tarball, { force: true });
  }
  rmSync(join(projectRoot, "dist"), { force: true, recursive: true });
  rmSync(temporaryRoot, { force: true, recursive: true });
}
