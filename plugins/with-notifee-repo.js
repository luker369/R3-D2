const { withProjectBuildGradle } = require('@expo/config-plugins');

// Notifee ships its Android artifact (app.notifee:core) in a local Maven repo
// inside node_modules, not on Maven Central. Without this repo added to the
// project-level allprojects block, Gradle can't resolve the dependency and the
// build fails with "Could not find app.notifee:core:+". Injecting it via a
// config plugin keeps the fix durable across `expo prebuild --clean`.
const MAVEN_LINE = 'maven { url("$rootDir/../node_modules/@notifee/react-native/android/libs") }';

module.exports = function withNotifeeRepo(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('[with-notifee-repo] expected groovy build.gradle');
    }
    if (config.modResults.contents.includes('@notifee/react-native/android/libs')) {
      return config; // already injected — idempotent
    }
    // Anchor inside the allprojects repositories block specifically (not the
    // buildscript one). The [^}]*? keeps the match within the inner block.
    const anchor = /(allprojects\s*\{\s*repositories\s*\{[^}]*?mavenCentral\(\))/;
    if (!anchor.test(config.modResults.contents)) {
      throw new Error(
        '[with-notifee-repo] could not find allprojects > repositories > mavenCentral() anchor'
      );
    }
    config.modResults.contents = config.modResults.contents.replace(
      anchor,
      `$1\n    ${MAVEN_LINE}`
    );
    return config;
  });
};
