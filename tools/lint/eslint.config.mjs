// Only rules tsc cannot do. Types come from the same tsconfigs `npm run typecheck` uses.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default tseslint.config({
  files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
  linterOptions: { reportUnusedDisableDirectives: 'error' },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      tsconfigRootDir: repoRoot,
      project: ['tsconfig.server.json', 'tsconfig.web.json', 'tsconfig.test.json'],
    },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: { '@typescript-eslint/no-floating-promises': 'error' },
});
