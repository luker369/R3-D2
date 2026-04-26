/**
 * components/listen-button.tsx
 *
 * The central action button. Color and label reflect the current assistant status.
 * Disabled (non-pressable, dimmed) while processing or speaking.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { AssistantStatus } from '@/hooks/use-voice-assistant';

const STATUS_CONFIG: Record<AssistantStatus, { label: string; color: string }> = {
  idle:       { label: 'Talk',          color: '#2563EB' }, // blue
  listening:  { label: 'Listening...', color: '#DC2626' }, // red
  processing: { label: 'Thinking...',  color: '#6B7280' }, // gray
  speaking:   { label: 'Speaking...',  color: '#16A34A' }, // green
  error:      { label: 'Try again',    color: '#D97706' }, // amber
};

type Props = {
  status: AssistantStatus;
  looping: boolean;
  onPress: () => void;
};

export function ListenButton({ status, looping, onPress }: Props) {
  const { label, color } = STATUS_CONFIG[status];
  const displayLabel = looping ? (status === 'idle' ? 'Stop' : label) : label;
  const displayColor = looping && status === 'idle' ? '#DC2626' : color;
  console.log("[BUTTON]", { status, displayLabel, looping });

  return (
    <Pressable
      onPress={onPress}
      style={[styles.button, { backgroundColor: displayColor }]}>
      <Text style={styles.label}>{displayLabel}</Text>
    </Pressable>
  );
}



const styles = StyleSheet.create({
  button: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  disabled: {
    opacity: 0.55,
  },
  label: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
});
