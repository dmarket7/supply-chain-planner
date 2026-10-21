import fs from 'node:fs';

/**
 * Reads KEY=value lines from .env for the local check scripts. Node 20's process.loadEnvFile returns
 * empty values for some files, so this parses the simple format itself. Shell variables win.
 */
export function loadEnv(file = '.env'): Record<string, string | undefined> {
  const vars = Object.fromEntries(
    (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
  );
  return { ...vars, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}
