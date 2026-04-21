const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = '.AssistInteractionService';
const SESSION_SERVICE_NAME = '.AssistInteractionSessionService';
const RECOGNITION_SERVICE_NAME = '.AssistRecognitionService';

function withManifestServices(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    if (!app.service) app.service = [];

    const hasService = (name) => app.service.some((s) => s.$['android:name'] === name);

    if (!hasService(SERVICE_NAME)) {
      app.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:permission': 'android.permission.BIND_VOICE_INTERACTION',
          'android:exported': 'true',
        },
        'meta-data': [
          {
            $: {
              'android:name': 'android.voice_interaction',
              'android:resource': '@xml/interaction_service',
            },
          },
        ],
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.service.voice.VoiceInteractionService' } },
            ],
          },
        ],
      });
    }

    if (!hasService(SESSION_SERVICE_NAME)) {
      app.service.push({
        $: {
          'android:name': SESSION_SERVICE_NAME,
          'android:permission': 'android.permission.BIND_VOICE_INTERACTION',
          'android:exported': 'true',
        },
      });
    }

    if (!hasService(RECOGNITION_SERVICE_NAME)) {
      app.service.push({
        $: {
          'android:name': RECOGNITION_SERVICE_NAME,
          'android:permission': 'android.permission.BIND_VOICE_RECOGNITION_SERVICE',
          'android:exported': 'true',
        },
        'meta-data': [
          {
            $: {
              'android:name': 'android.speech',
              'android:resource': '@xml/recognition_service',
            },
          },
        ],
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.speech.RecognitionService' } },
            ],
          },
        ],
      });
    }

    return config;
  });
}

function withNativeSources(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;
      const packageName = AndroidConfig.Package.getPackage(config);
      if (!packageName) throw new Error('[with-voice-interaction] Android package not set');
      const packagePath = packageName.replace(/\./g, '/');

      const javaDir = path.join(platformRoot, 'app/src/main/java', packagePath);
      const xmlDir = path.join(platformRoot, 'app/src/main/res/xml');
      await fs.promises.mkdir(javaDir, { recursive: true });
      await fs.promises.mkdir(xmlDir, { recursive: true });

      const serviceKt = `package ${packageName}

import android.service.voice.VoiceInteractionService

class AssistInteractionService : VoiceInteractionService()
`;

      const sessionKt = `package ${packageName}

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.util.Log
import com.facebook.react.modules.core.DeviceEventManagerModule

class AssistInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession {
        return AssistInteractionSession(this)
    }
}

class AssistInteractionSession(context: Context) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        Log.d("R2Assist", "onShow fired, showFlags=\$showFlags")

        // Authoritative warm-check: AudioStreamModule's static liveContext is
        // populated by React itself when the module is constructed and cleared
        // on invalidate(). The reactHost computed-property getter is unreliable
        // in new arch — it can return a host whose currentReactContext is null
        // even when JS is alive, which previously caused warm corner-swipes to
        // be dropped.
        val reactCtx = AudioStreamModule.currentReactContext()
        Log.d("R2Assist", "AudioStreamModule.currentReactContext=\${if (reactCtx != null) "non-null" else "null"}")

        if (reactCtx != null) {
            try {
                reactCtx
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("r2Assist", null)
                Log.d("R2Assist", "emitted r2Assist event, staying in background")
            } catch (t: Throwable) {
                Log.d("R2Assist", "emit threw: \${t.javaClass.simpleName}: \${t.message}")
            }
        } else {
            // No live React context => process is genuinely cold. Only then is
            // it safe to launch MainActivity; doing so when JS is alive would
            // pop the UI to the foreground.
            Log.d("R2Assist", "no live React context — true cold start, startActivity")
            val intent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse("r3d2://assist")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            context.startActivity(intent)
        }
        hide()
    }
}
`;

      const recognitionKt = `package ${packageName}

import android.content.Intent
import android.speech.RecognitionService

class AssistRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
        listener?.error(android.speech.SpeechRecognizer.ERROR_CLIENT)
    }
    override fun onCancel(listener: Callback?) {}
    override fun onStopListening(listener: Callback?) {}
}
`;

      const xml = `<?xml version="1.0" encoding="utf-8"?>
<voice-interaction-service
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:sessionService="${packageName}.AssistInteractionSessionService"
    android:recognitionService="${packageName}.AssistRecognitionService"
    android:supportsAssist="true"
    android:supportsLaunchVoiceAssistFromKeyguard="true" />
`;

      const recognitionXml = `<?xml version="1.0" encoding="utf-8"?>
<recognition-service xmlns:android="http://schemas.android.com/apk/res/android" />
`;

      await fs.promises.writeFile(path.join(javaDir, 'AssistInteractionService.kt'), serviceKt);
      await fs.promises.writeFile(path.join(javaDir, 'AssistInteractionSessionService.kt'), sessionKt);
      await fs.promises.writeFile(path.join(javaDir, 'AssistRecognitionService.kt'), recognitionKt);
      await fs.promises.writeFile(path.join(xmlDir, 'interaction_service.xml'), xml);
      await fs.promises.writeFile(path.join(xmlDir, 'recognition_service.xml'), recognitionXml);

      return config;
    },
  ]);
}

module.exports = function withVoiceInteraction(config) {
  config = withManifestServices(config);
  config = withNativeSources(config);
  return config;
};
