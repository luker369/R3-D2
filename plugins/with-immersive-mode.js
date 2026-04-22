const { withMainActivity, withAndroidStyles } = require('@expo/config-plugins');

// Hides the system nav bar (and status bar) at the activity level via
// WindowInsetsControllerCompat. expo-navigation-bar's JS API became unreliable
// on SDK 54 / Android 15 even with edgeToEdgeEnabled=false; doing it natively
// in MainActivity.onCreate is the durable fix. Swipe from a system edge
// transiently reveals the bars, then they auto-hide.
const IMMERSIVE_IMPORTS = `
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
`;

const IMMERSIVE_BLOCK = `
    WindowCompat.setDecorFitsSystemWindows(window, false)
    hideSystemBars()
    window.decorView.post { hideSystemBars() }
    // Re-hide the moment Android re-exposes the bars (transient swipe-reveal,
    // IME dismiss, etc.). BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE is the least
    // aggressive the system offers — this listener kills the transient flash.
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      if (insets.isVisible(WindowInsetsCompat.Type.systemBars())) {
        hideSystemBars()
      }
      insets
    }
`;

const HIDE_FN_AND_FOCUS_OVERRIDE = `
  private fun hideSystemBars() {
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.systemBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  override fun onResume() {
    super.onResume()
    hideSystemBars()
    window.decorView.post { hideSystemBars() }
  }

  // Any touch re-asserts immersive. Catches the case where the user's swipe
  // transiently reveals the bars — as soon as the next touch arrives, they
  // hide again. super.dispatchTouchEvent runs first so React Native's gesture
  // handling is unaffected.
  override fun dispatchTouchEvent(ev: android.view.MotionEvent?): Boolean {
    val res = super.dispatchTouchEvent(ev)
    hideSystemBars()
    return res
  }

`;

function withImmersiveStyles(config) {
  return withAndroidStyles(config, (config) => {
    const styles = config.modResults;
    const appTheme = styles.resources.style?.find(
      (s) => s.$.name === 'AppTheme',
    );
    if (!appTheme) return config;
    if (!appTheme.item) appTheme.item = [];
    // Drop enforceNavigationBarContrast and the white statusBarColor — both
    // keep the bars visibly drawing even when WindowInsetsController hides.
    appTheme.item = appTheme.item.filter((it) => {
      const n = it.$.name;
      return n !== 'android:enforceNavigationBarContrast'
        && n !== 'android:statusBarColor';
    });
    const setItem = (name, value, extra = {}) => {
      let existing = appTheme.item.find((it) => it.$.name === name);
      if (!existing) {
        existing = { $: { name, ...extra }, _: value };
        appTheme.item.push(existing);
      } else {
        existing._ = value;
      }
    };
    setItem('android:windowTranslucentStatus', 'true');
    setItem('android:windowTranslucentNavigation', 'true');
    setItem('android:navigationBarColor', '@android:color/transparent');
    return config;
  });
}

module.exports = function withImmersiveMode(config) {
  config = withImmersiveStyles(config);
  return withMainActivity(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error('[with-immersive-mode] expected MainActivity.kt (Kotlin)');
    }
    let src = config.modResults.contents;
    if (src.includes('hideSystemBars')) {
      return config; // already applied — idempotent
    }
    if (!/import com\.facebook\.react\.ReactActivity\n/.test(src)) {
      throw new Error('[with-immersive-mode] could not find ReactActivity import anchor');
    }
    if (!/super\.onCreate\(null\)/.test(src)) {
      throw new Error('[with-immersive-mode] could not find super.onCreate(null) anchor');
    }
    src = src.replace(
      /(import com\.facebook\.react\.ReactActivity\n)/,
      `$1${IMMERSIVE_IMPORTS}`
    );
    src = src.replace(
      /(super\.onCreate\(null\))/,
      `$1${IMMERSIVE_BLOCK}`
    );
    // Inject hide fn + focus override right before the closing brace of MainActivity.
    // Anchor on the last brace after invokeDefaultOnBackPressed's closing brace.
    src = src.replace(
      /(\n\})\s*$/,
      `\n${HIDE_FN_AND_FOCUS_OVERRIDE}$1\n`
    );
    config.modResults.contents = src;
    return config;
  });
};
