module.exports = function (api) {
  api.cache(true);
  // Console stripping is disabled while we diagnose voice-loop freezes.
  // Re-enable by setting STRIP_CONSOLE=1 in the build environment.
  const stripConsole = process.env.STRIP_CONSOLE === '1';
  return {
    presets: ['babel-preset-expo'],
    plugins: stripConsole
      ? [['transform-remove-console', { exclude: ['error', 'warn'] }]]
      : [],
  };
};
