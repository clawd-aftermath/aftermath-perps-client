import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    aftermath: "src/aftermath.ts",
    react: "src/react.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  external: ["react"],
});
