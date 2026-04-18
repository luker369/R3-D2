/**
 * components/transcript-view.tsx
 *
 * Scrollable conversation log.
 * User turns are right-aligned (blue tint), assistant turns are left-aligned (gray).
 * Auto-scrolls to the bottom whenever entries change.
 *
 * Later: replace with a FlatList for better performance on long conversations,
 * and add timestamps once Supabase persistence is in place.
 */

import React, { useRef, useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TranscriptEntry } from '@/hooks/use-voice-assistant';

type Props = {
  entries: TranscriptEntry[];
};

export function TranscriptView({ entries }: Props) {
  const scrollRef = useRef<ScrollView>(null);

  // Scroll to bottom whenever a new entry is added
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Tap the button and start talking.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.content}>
      {entries.map(entry => (
        <View
          key={entry.id}
          style={[
            styles.bubble,
            entry.role === 'user' ? styles.userBubble : styles.assistantBubble,
          ]}>
          <Text style={styles.role}>
            {entry.role === 'user' ? 'You' : 'Assistant'}
          </Text>
          <Text style={styles.text}>{entry.text}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    width: '100%',
  },
  content: {
    padding: 16,
    gap: 10,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  bubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 14,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#DBEAFE', // light blue
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#F3F4F6', // light gray
  },
  role: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    marginBottom: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  text: {
    fontSize: 15,
    color: '#111827',
    lineHeight: 21,
  },
});
