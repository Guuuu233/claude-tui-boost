// Only operator-selected boolean recovery options cross the managed boundary.
// Never forward arbitrary environment names, credentials or legacy certificates.
const recoveryFlags = [
  'MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL',
  'MAGPIE_CLAUDE_AUTO_RECOVER_ORPHANS',
  'MAGPIE_CLAUDE_AUTO_RECOVER_RETRY',
  'MAGPIE_CLAUDE_NATIVE_TMUX_GUARD',
  'MAGPIE_CLAUDE_FIRST_TURN_ANCHOR',
  'MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT',
];

export function runtimeEnvironment(base, source) {
  const clean = { ...base };
  for (const name of recoveryFlags) {
    if (source[name] === '0' || source[name] === '1') clean[name] = source[name];
  }
  return clean;
}
