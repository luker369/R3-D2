/**
 * app/(tabs)/index.tsx
 *
 * Main (and only) screen for step 1.
 * This file is intentionally thin — it wires the UI components to the
 * useVoiceAssistant hook and handles layout. No logic lives here.
 *
 * Layout:
 *   ┌─────────────────┐
 *   │  transcript     │  (scrollable, flex 1)
 *   │                 │
 *   ├─────────────────┤
 *   │  error banner   │  (only visible on error)
 *   ├─────────────────┤
 *   │  [ button ]     │  (fixed at bottom)
 *   └─────────────────┘
 */

import { StyleSheet, Text, View } from 'react-native';
import { useVoiceAssistant } from '@/hooks/use-voice-assistant';
import { ListenButton } from '@/components/listen-button';
import { TranscriptView } from '@/components/transcript-view';

export default function HomeScreen() {
  const { status, transcript, error, handlePress } = useVoiceAssistant();

  return (
    <View style={styles.container}>
      {/* Conversation transcript */}
      <TranscriptView entries={transcript} />

      {/* Error banner — only rendered when there's an active error */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Central listen/speak button */}
      <View style={styles.buttonRow}>
        <ListenButton status={status} onPress={handlePress} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  errorBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  errorText: {
    color: '#92400E',
    fontSize: 13,
    textAlign: 'center',
  },
  buttonRow: {
    paddingVertical: 36,
    alignItems: 'center',
  },
});
