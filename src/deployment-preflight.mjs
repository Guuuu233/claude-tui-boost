import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function privateRegular(path, uid, errors, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { errors.push(`${label} is missing or inaccessible`); return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    errors.push(`${label} must be a real regular file, not a symlink`);
    return false;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) errors.push(`${label} must not be readable or writable by group/others`);
  if (uid !== undefined && stat.uid !== uid) errors.push(`${label} is not owned by the Magpie service UID`);
  return true;
}

// Explicit paths only. This checks configuration metadata, never reads
// OAuth/auth files, contacts a server, relaunches a process, or emits secrets.
export function inspectDeployment({ pluginsPath, runtimeDir, serviceUid = process.getuid?.() } = {}) {
  const errors = [], warnings = [];
  if (!pluginsPath || !runtimeDir ||
      (serviceUid !== undefined && (!Number.isSafeInteger(serviceUid) || serviceUid < 0))) {
    return { ok: false, errors: ['--plugins, --runtime-dir and a valid service UID are required'], warnings };
  }
  let port = null;
  try {
    const state = lstatSync(runtimeDir);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      errors.push('runtime directory must be a real directory, not a symlink');
    } else if (serviceUid !== undefined && state.uid !== serviceUid) {
      errors.push('runtime directory is not owned by the Magpie service UID');
    }
  } catch { errors.push('runtime directory is missing or inaccessible'); }

  const portFile = join(runtimeDir, 'port');
  if (privateRegular(portFile, serviceUid, errors, 'runtime port file')) {
    try {
      const raw = readFileSync(portFile, 'utf8').trim();
      if (!/^[0-9]{1,5}$/.test(raw)) throw Error('bad port');
      port = Number(raw);
      if (port < 1 || port > 65535) throw Error('bad port');
    } catch { errors.push('runtime port file contains an invalid port'); port = null; }
  }

  let activeAdapters = 0;
  if (privateRegular(pluginsPath, serviceUid, errors, 'plugins.json')) {
    let rows;
    try {
      const loaded = JSON.parse(readFileSync(pluginsPath, 'utf8'));
      rows = loaded?.plugins;
      if (!Array.isArray(rows)) throw Error('invalid plugins list');
    } catch { errors.push('plugins.json is not valid plugin configuration'); }
    if (rows) {
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.spec !== 'string') {
          errors.push('plugin entry is malformed');
          continue;
        }
        if (!row.spec.includes('magpie-claude-tui')) continue;
        const selected = row.off !== true;
        const endpoint = row.options?.runtimeURL;
        const expected = port === null ? null : `http://127.0.0.1:${port}/v1/`;
        if (selected) {
          activeAdapters++;
          if (endpoint === undefined) {
            warnings.push('enabled adapter uses managed runtime mode; external runtime port check is not applicable');
          } else if (!expected || endpoint !== expected) {
            errors.push('enabled adapter runtimeURL does not match the private current loopback port');
          }
        } else if (endpoint !== undefined && expected && endpoint !== expected) {
          warnings.push('disabled Claude TUI adapter has stale runtimeURL; verify before enabling');
        }
      }
      if (activeAdapters !== 1) errors.push(`expected exactly one enabled Claude TUI adapter; found ${activeAdapters}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, activeAdapters,
    ...(port === null ? {} : { runtimePort: port }) };
}
