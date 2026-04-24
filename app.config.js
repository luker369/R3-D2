const appJson = require('./app.json');

const FALLBACK_GOOGLE_ANDROID_CLIENT_ID =
  '823254735040-0uo2mnrd0mc0fiv7bff95jo46uaegdtp.apps.googleusercontent.com';

function resolveGoogleAndroidClientId(extra) {
  const envGoogleAndroidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  if (envGoogleAndroidClientId && envGoogleAndroidClientId.trim()) {
    return envGoogleAndroidClientId.trim();
  }

  if (typeof extra.googleAndroidClientId === 'string' && extra.googleAndroidClientId.trim()) {
    return extra.googleAndroidClientId.trim();
  }

  return FALLBACK_GOOGLE_ANDROID_CLIENT_ID;
}

function reverseGoogleClientId(clientId) {
  return `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;
}

module.exports = ({ config }) => {
  const expoConfig = appJson.expo ?? {};
  const extra = expoConfig.extra ?? {};
  const googleAndroidClientId = resolveGoogleAndroidClientId(extra);
  const googleRedirectScheme = reverseGoogleClientId(googleAndroidClientId);
  const android = expoConfig.android ?? {};
  const intentFilters = Array.isArray(android.intentFilters) ? android.intentFilters : [];
  const filteredIntentFilters = intentFilters.filter((filter) => {
    if (!Array.isArray(filter?.data)) return true;
    return !filter.data.some(
      (entry) =>
        typeof entry?.scheme === 'string' &&
        entry.scheme.startsWith('com.googleusercontent.apps.'),
    );
  });

  return {
    ...config,
    ...expoConfig,
    android: {
      ...android,
      intentFilters: [
        ...filteredIntentFilters,
        {
          action: 'VIEW',
          data: [{ scheme: googleRedirectScheme }],
          category: ['DEFAULT', 'BROWSABLE'],
        },
      ],
    },
    extra: {
      ...extra,
      googleAndroidClientId,
    },
  };
};
