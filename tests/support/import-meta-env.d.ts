// Global augmentation for the ROOT program only (tsconfig.json includes tests/**).
// Gate tests such as tests/gate/ui/screens-model.test.ts import ui/src/listing
// modules, which reach ui/src/api.ts and its `import.meta.env` reads. In the ui
// program that shape comes from vite/client (ui/tsconfig.json); the root program
// has no vite types, so this declares the same minimal shape. Keep it minimal:
// the values are strings or absent, exactly what api.ts guards with `??`.
interface ImportMeta {
  readonly env: Record<string, string | undefined>;
}
