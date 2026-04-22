import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import LottieView from 'lottie-react-native';
import { AnimatedBackground } from '@/components/animated-background';
import { useVoiceAssistant } from '@/hooks/use-voice-assistant';
import { ListenButton } from '@/components/listen-button';
import { TranscriptView } from '@/components/transcript-view';
import { R2_CHIRP_ON_EVERY_HOME_FOCUS } from '@/lib/r2-chirp-config';
import { playR2Chirp } from '@/lib/r2-chirp';

export default function HomeScreen() {
  const {
    status,
    transcript,
    error,
    looping,
    handlePress,
    pendingImage,
    setPendingImage,
    sendText,
  } = useVoiceAssistant();
  const [pendingText, setPendingText] = useState('');
  // Snapshot the transcript length when an image is picked so the pending
  // bubble is rendered at that position and drifts upward as new turns
  // arrive below it, instead of sitting pinned to the bottom.
  const [pendingImageAnchor, setPendingImageAnchor] = useState<number | null>(null);

  useEffect(() => {
    if (!pendingImage) setPendingImageAnchor(null);
  }, [pendingImage]);

  useFocusEffect(
    useCallback(() => {
      if (!R2_CHIRP_ON_EVERY_HOME_FOCUS) return;
      const cleanup = playR2Chirp();
      return cleanup;
    }, []),
  );

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      base64: false,
    });
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const uri = asset.uri;
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    const mimeType = asset.mimeType ?? 'image/jpeg';
    console.log(
      '[img] picked uri=', uri.slice(0, 80),
      'mime=', mimeType,
      'base64Bytes=', base64.length,
    );
    setPendingImageAnchor(transcript.length);
    setPendingImage({ uri, base64, mimeType });
  }

  function doSend() {
    const t = pendingText.trim();
    if (!t && !pendingImage) return;
    setPendingText('');
    void sendText(pendingText);
  }

  return (
    <View style={styles.container}>
      <AnimatedBackground />
      <View style={styles.robotAnchor}>
        <LottieView
          source={require('../assets/images/robot.json')}
          autoPlay
          loop
          style={styles.robot}
        />
      </View>
      <TranscriptView
        entries={transcript}
        pendingImageUri={pendingImage?.uri ?? null}
        pendingImageAnchor={pendingImageAnchor}
        onRemovePending={() => setPendingImage(null)}
      />

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.bottomRow}>
        <ListenButton status={status} looping={looping} onPress={handlePress} />
      </View>

      <View style={styles.inputPill}>
        <TouchableOpacity style={styles.clipBtn} onPress={pickImage}>
          <Text style={styles.clipIcon}>📎</Text>
        </TouchableOpacity>

        <TextInput
          style={styles.textInput}
          value={pendingText}
          onChangeText={setPendingText}
          onSubmitEditing={doSend}
          placeholder="Type to R2..."
          placeholderTextColor="rgba(255,255,255,0.4)"
          returnKeyType="send"
          blurOnSubmit
          multiline={false}
        />

        <TouchableOpacity style={styles.sendBtn} onPress={doSend}>
          <Text style={styles.sendIcon}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0f',
  },
  robotAnchor: {
    position: 'absolute',
    left: '50%',
    marginLeft: -190,
    top: '28%',
    zIndex: 0,
  },
  robot: {
    width: 380,
    height: 380,
  },
  errorBanner: {
    marginHorizontal: 12,
    marginBottom: 12,
    paddingVertical: 18,
    paddingHorizontal: 18,
    backgroundColor: 'rgba(251,191,36,0.22)',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'rgba(251,191,36,0.55)',
  },
  errorText: {
    color: '#FCD34D',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 26,
    textAlign: 'center',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 22,
  },
  inputPill: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 28,
    paddingHorizontal: 8,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  clipBtn: {
    width: 40,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipIcon: {
    fontSize: 21,
    color: '#fff',
    lineHeight: 28,
  },
  textInput: {
    flex: 1,
    minHeight: 52,
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  sendBtn: {
    minWidth: 52,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  sendIcon: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '600',
  },
});
