import fs from 'fs';
import path from 'path';

// Load environment from .env, strict KEY=value only (align with .env.example)
export function loadEnvFromDotenv() {
  const cwd = process.cwd();
  const envPath = path.resolve(cwd, '.env');
  const examplePath = path.resolve(cwd, '.env.example');
  if (!fs.existsSync(envPath)) return;

  const readFileSafe = (p) => {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  };

  // Allowed keys come from .env.example when present
  const exContent = readFileSafe(examplePath);
  const allowedKeys = new Set();
  for (const raw of exContent.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) allowedKeys.add(m[1]);
  }

  const content = readFileSafe(envPath);
  const lines = content.split(/\r?\n/);
  const loaded = [];
  const errors = [];
  const unknown = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Strict: KEY=value only, no 'export', no quoting syntax, no spaces around '='
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) {
      errors.push({ line: i + 1, content: raw });
      continue;
    }
    const key = m[1];
    const val = m[2];
    if (allowedKeys.size && !allowedKeys.has(key)) {
      unknown.push({ key, line: i + 1 });
    }
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = val;
      loaded.push({ key, value: val });
    }
  }

  // Log results and any issues
  const mask = (k, v) => (/key|secret|token|password/i.test(k) ? (v.length <= 6 ? '***' : v.slice(0,2) + '***' + v.slice(-2)) : v);
  if (loaded.length) {
    const pairs = loaded.map(({ key, value }) => `${key}=${mask(key, String(value))}`).join(', ');
    console.log(`Loaded env from .env: ${pairs}`);
  } else {
    console.log('Loaded env from .env: (no new variables)');
  }
  if (unknown.length) {
    const names = unknown.map(u => `${u.key}@line${u.line}`).join(', ');
    console.warn(`.env contains keys not present in .env.example: ${names}`);
  }
  if (errors.length) {
    const linesDesc = errors.map(e => `line ${e.line}: ${String(e.content).replace(/\s+/g,' ').trim()}`).join('; ');
    console.error(`.env parse error(s): lines must be KEY=value (no quotes/exports). Offending: ${linesDesc}`);
  }
}

// Parse flexible boolean-ish values from env/inputs
// Accepts: true/false, 1/0, yes/no, on/off (case-insensitive). Falls back when unknown.
export function parseBoolean(val, fallback = false) {
  if (val == null) return fallback;
  if (typeof val === 'boolean') return val;
  const s = String(val).toLowerCase().trim();
  if (!s) return fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}
