import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import LottieView from 'lottie-react-native';
import { AnimatedBackground } from '@/components/animated-background';
import { useVoiceAssistant } from '@/hooks/use-voice-assistant';
import { ListenButton } from '@/components/listen-button';
import { TranscriptView } from '@/components/transcript-view';

export default function HomeScreen() {
  const { status, transcript, error, looping, handlePress, pendingImage, setPendingImage } = useVoiceAssistant();

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      base64: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    setPendingImage({ uri, base64 });
  }

  return (
    <View style={styles.container}>
      <AnimatedBackground />
      <View style={styles.robotAnchor}>
        <LottieView
          source={require('../../assets/images/robot.json')}
          autoPlay
          loop
          style={styles.robot}
        />
      </View>
      <TranscriptView entries={transcript} />

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.spacer} />

      <View style={styles.bottomRow}>
        <TouchableOpacity style={styles.cameraBtn} onPress={pickImage}>
          <Text style={styles.cameraIcon}>📎</Text>
          {pendingImage && (
            <Image source={{ uri: pendingImage.uri }} style={styles.thumb} />
          )}
        </TouchableOpacity>

        <ListenButton status={status} looping={looping} onPress={handlePress} />

        <View style={styles.cameraBtn} />
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
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(251,191,36,0.15)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.3)',
  },
  errorText: {
    color: '#FCD34D',
    fontSize: 13,
    textAlign: 'center',
  },
  spacer: {
    flex: 1,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingVertical: 36,
  },
  cameraBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraIcon: {
    fontSize: 26,
  },
  thumb: {
    position: 'absolute',
    top: -36,
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#3B82F6',
  },
});
