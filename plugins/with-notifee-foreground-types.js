const { withAndroidManifest } = require('@expo/config-plugins');

const NOTIFEE_SERVICE = 'app.notifee.core.ForegroundService';

module.exports = function withNotifeeForegroundTypes(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const app = manifest.application[0];
    if (!app.service) app.service = [];

    const existing = app.service.find((s) => s.$['android:name'] === NOTIFEE_SERVICE);
    if (existing) {
      existing.$['android:foregroundServiceType'] = 'microphone';
      existing.$['tools:replace'] = 'android:foregroundServiceType';
    } else {
      app.service.push({
        $: {
          'android:name': NOTIFEE_SERVICE,
          'android:foregroundServiceType': 'microphone',
          'tools:replace': 'android:foregroundServiceType',
        },
      });
    }

    return config;
  });
};
