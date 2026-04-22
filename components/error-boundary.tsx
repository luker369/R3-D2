/**
 * Root error boundary. Catches render-time throws in the component tree so a
 * single bad render doesn't whitescreen the app with no recovery path. Mount
 * this at the top of app/_layout.tsx, outside the ThemeProvider/Stack.
 *
 * Does NOT catch async errors, promise rejections, or event-handler throws —
 * that's a React limitation. Those still surface via console.warn/error and
 * the idle watchdogs / AbortControllers in the voice loop.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type Props = { children: ReactNode };
type State = { err: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] render threw:', err?.message, info?.componentStack);
  }

  reset = () => {
    this.setState({ err: null });
  };

  render() {
    if (this.state.err) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something broke.</Text>
          <Text style={styles.message}>{this.state.err.message}</Text>
          <TouchableOpacity style={styles.button} onPress={this.reset}>
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#FCD34D',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  message: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 24,
    backgroundColor: 'rgba(59,130,246,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.55)',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
