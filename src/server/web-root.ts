// Where the server finds the built web app when VOLVERAN_WEB_ROOT is unset.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `dist/web` next to the compiled server (`dist/server/main.js`), or
 * undefined when the server runs from source (`tsx src/server/main.ts`):
 * there `../web` is `src/web`, the Vite source, whose `index.html` loads
 * `main.tsx` and which no browser can run. In development Vite serves the
 * web app (`npm run dev`, http://localhost:5173).
 */
export function defaultWebRoot(moduleUrl: string): string | undefined {
  const file = fileURLToPath(moduleUrl);
  if (path.extname(file) === '.ts') return undefined;
  return path.resolve(path.dirname(file), '../web');
}
