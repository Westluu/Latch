import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts", "src/sidecar.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  jsx: "automatic",
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  plugins: [
    {
      name: "stub-devtools",
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export default undefined;",
        }));
      },
    },
  ],
});

console.log("Bundled successfully");
