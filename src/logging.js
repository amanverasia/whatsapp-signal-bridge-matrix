const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info') {
  const maxLevel = LEVELS[level] ?? LEVELS.info;

  function log(levelName, msg) {
    if (LEVELS[levelName] > maxLevel) return;
    const ts = new Date().toISOString();
    const line = `${ts} [${levelName.toUpperCase()}] ${msg}\n`;
    if (levelName === 'error' || levelName === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    error: (msg) => log('error', msg),
    warn: (msg) => log('warn', msg),
    info: (msg) => log('info', msg),
    debug: (msg) => log('debug', msg),
  };
}
