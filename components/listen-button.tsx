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
  onPress: () => void;
};

export function ListenButton({ status, onPress }: Props) {
  const { label, color } = STATUS_CONFIG[status];
  const disabled = status === 'processing' || status === 'speaking';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, { backgroundColor: color }, disabled && styles.disabled]}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 180,
    height: 180,
    borderRadius: 90,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  disabled: {
    opacity: 0.55,
  },
  label: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
});
