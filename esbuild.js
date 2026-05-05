const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const watchPlugin = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const err of result.errors) {
        console.error(
          `✘ [ERROR] ${err.text}\n    ${err.location?.file}:${err.location?.line}:${err.location?.column}:`,
        );
      }
      console.log('[watch] build finished');
    });
  },
};

function copyMonaco() {
  const src = path.join('node_modules', 'monaco-editor', 'min', 'vs');
  const dst = path.join('dist', 'monaco', 'vs');
  if (!fs.existsSync(src)) {
    console.warn('[monaco] source missing, skipping copy:', src);
    return;
  }
  fs.rmSync(path.join('dist', 'monaco'), { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log('[monaco] copied to', dst);
}

function copyKatex() {
  const srcDir = path.join('node_modules', 'katex', 'dist');
  const dstDir = path.join('dist', 'katex');
  if (!fs.existsSync(srcDir)) {
    console.warn('[katex] source missing, skipping copy:', srcDir);
    return;
  }
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(dstDir, { recursive: true });
  // Stylesheet + font directory are required for proper math rendering.
  fs.copyFileSync(path.join(srcDir, 'katex.min.css'), path.join(dstDir, 'katex.min.css'));
  const fontsSrc = path.join(srcDir, 'fonts');
  const fontsDst = path.join(dstDir, 'fonts');
  if (fs.existsSync(fontsSrc)) {
    fs.cpSync(fontsSrc, fontsDst, { recursive: true });
  }
  console.log('[katex] copied to', dstDir);
}

function copyCustomThemes() {
  const srcDir = path.join('src', 'themes');
  const dstDir = path.join('dist', 'themes');
  if (!fs.existsSync(srcDir)) return;
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(dstDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    if (file.endsWith('.json')) {
      fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
    }
  }
  console.log('[themes] copied custom theme JSON to', dstDir);
}

function copyCodicons() {
  const srcDir = path.join('node_modules', '@vscode', 'codicons', 'dist');
  const dstDir = path.join('dist', 'codicons');
  if (!fs.existsSync(srcDir)) {
    console.warn('[codicons] source missing, skipping copy:', srcDir);
    return;
  }
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
  }
  console.log('[codicons] copied to', dstDir);
}


const baseOpts = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [watchPlugin],
};

async function main() {
  copyMonaco();
  copyCodicons();
  copyKatex();
  copyCustomThemes();

  const extensionCtx = await esbuild.context({
    ...baseOpts,
    entryPoints: ['src/extension.ts'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
  });

  const webviewCtx = await esbuild.context({
    ...baseOpts,
    entryPoints: ['src/webview/index.ts'],
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/webview.js',
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
