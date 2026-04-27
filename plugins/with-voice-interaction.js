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

class AssistInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession {
        return AssistInteractionSession(this)
    }
}

class AssistInteractionSession(context: Context) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        Log.d("R2Assist", "onShow fired, showFlags=\$showFlags")

        // Corner swipe is treated as an explicit UI launch request — always
        // foreground MainActivity, warm or cold. This is the ONLY site in the
        // app that launches MainActivity, so UI promotion remains scoped to the
        // assist gesture (no voice-pipeline or background event can surface it).
        // URL uses a query string instead of a path so expo-router resolves
        // it to the home route (tabs) instead of looking for a \`/assist\` route
        // file. The "assist" marker is preserved in the query so the JS
        // Linking handler can still detect it and arm the listener.
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("r3d2:///?assist=1")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        context.startActivity(intent)
        hide()
    }
}
`;

      const recognitionKt = `package ${packageName}

import android.content.Intent
import android.speech.RecognitionService

class AssistRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
        // listener?.error(android.speech.SpeechRecognizer.ERROR_CLIENT)
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
