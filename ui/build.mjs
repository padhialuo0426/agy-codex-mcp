import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./panel.mjs", import.meta.url))],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
});
const template = await readFile(new URL("./panel.html", import.meta.url), "utf8");
const script = bundle.outputFiles[0].text.replaceAll(/<\/script/gi, "<\\/script");
await writeFile(new URL("../dist/panel.html", import.meta.url), template.replace("<!--BUNDLE-->", () => `<script>${script}</script>`));
