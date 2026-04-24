import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

export default function GoogleOAuthRedirectScreen() {
  useEffect(() => {
    const timer = setTimeout(() => {
      router.replace('/');
    }, 50);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#60A5FA" />
      <Text style={styles.text}>Finishing Google sign-in...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a0a0f',
    gap: 16,
  },
  text: {
    color: '#E5E7EB',
    fontSize: 16,
    fontWeight: '600',
  },
});
