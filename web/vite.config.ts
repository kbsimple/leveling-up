import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vitest/config';

function git(cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string;
  devDependencies: Record<string, string>;
};

/** Identity of this build, shown on /statusz and served as /statusz.json. */
const commit = process.env.GITHUB_SHA || git('rev-parse HEAD') || 'unknown';
const buildInfo = {
  service: 'leveling-up-web',
  version: pkg.version,
  releaseDate: git('log -1 --format=%cI') || 'unknown',
  builtAt: new Date().toISOString(),
  commit,
  commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 8),
  branch: process.env.GITHUB_REF_NAME || git('rev-parse --abbrev-ref HEAD') || 'unknown',
  context: process.env.GITHUB_ACTIONS ? 'github-pages' : 'local',
  features: {
    'Widget card (glucose, IOB, 2h boluses)': true,
    'Glucose graph with bolus markers': true,
    'Bolus history (2/6/24h)': true,
    'Basal & Control-IQ summary': true,
    'Settings in browser storage': true,
  },
  deps: Object.fromEntries(Object.entries(pkg.devDependencies)),
};

function statuszJson(): Plugin {
  return {
    name: 'statusz-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'statusz.json',
        source: `${JSON.stringify({ ...buildInfo, status: 'ok' }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build works under GitHub Pages' /leveling-up/.
  base: './',
  define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
  plugins: [statuszJson()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        statusz: resolve(import.meta.dirname, 'statusz/index.html'),
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
