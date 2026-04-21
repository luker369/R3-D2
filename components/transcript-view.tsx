import { useEffect, useRef } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TranscriptEntry } from '@/hooks/use-voice-assistant';

type Props = {
  entries: TranscriptEntry[];
};

export function TranscriptView({ entries }: Props) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    // Defer so layout has a chance to measure the new bubble before we scroll.
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 16);
    return () => clearTimeout(t);
  }, [entries.length, entries[entries.length - 1]?.text]);

  if (entries.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Tap the button and start talking.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {entries.map((e) => (
        <View
          key={e.id}
          style={[styles.bubble, e.role === 'assistant' ? styles.assistantBubble : styles.userBubble]}
        >
          {e.imageUri && (
            <Image source={{ uri: e.imageUri }} style={styles.image} resizeMode="cover" />
          )}
          {e.text ? <Text selectable style={styles.text}>{e.text}</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 48,
    paddingBottom: 12,
    justifyContent: 'flex-end',
    gap: 12,
  },
  emptyContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 12,
    justifyContent: 'flex-end',
  },
  bubble: {
    padding: 14,
    borderRadius: 16,
    gap: 8,
  },
  assistantBubble: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignSelf: 'flex-start',
    maxWidth: '90%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  userBubble: {
    backgroundColor: 'rgba(99,102,241,0.35)',
    alignSelf: 'flex-end',
    maxWidth: '90%',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.5)',
  },
  text: {
    fontSize: 16,
    color: '#f1f5f9',
    lineHeight: 23,
  },
  image: {
    width: 220,
    height: 160,
    borderRadius: 10,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 20,
  },
});
