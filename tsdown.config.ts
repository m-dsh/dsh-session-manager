import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'lib',
    clean: true,
    external: ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-settings', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-connection'],
    // 产物由 DSH 直接加载、不再二次压缩；去掉注释可避免打包器注入的
    // /* @__PURE__ */ 标注被静态校验误判为未替换模板占位符。
    outputOptions: { comments: false },
  },
  {
    entry: ['src/client/index.ts'],
    format: ['cjs'],
    outDir: 'lib',
    outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
    external: ['react', '@deepseek-ai/dsh-client-connection'],
    outputOptions: {
      comments: false,
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-session-manager", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module={exports:{}}; var exports=module.exports;',
    },
  },
])
