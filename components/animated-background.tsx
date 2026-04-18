import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';

type BlobConfig = {
  a: number;
  b: number;
  delta: number;
  radiusX: number;
  radiusY: number;
  centerX: number;
  centerY: number;
  size: number;
  baseHue: number;
  hueSpeed: number;
  speed: number;
};

const BLOBS: BlobConfig[] = [
  { a: 3, b: 2, delta: 0,         radiusX: 130, radiusY: 170, centerX: 200, centerY: 380, size: 340, baseHue: 270, hueSpeed: 18, speed: 0.35 },
  { a: 2, b: 3, delta: Math.PI/2, radiusX: 150, radiusY: 120, centerX: 180, centerY: 300, size: 300, baseHue: 190, hueSpeed: 22, speed: 0.28 },
  { a: 5, b: 4, delta: Math.PI/4, radiusX: 110, radiusY: 140, centerX: 210, centerY: 450, size: 280, baseHue: 320, hueSpeed: 15, speed: 0.42 },
  { a: 3, b: 5, delta: Math.PI/3, radiusX: 140, radiusY: 100, centerX: 190, centerY: 350, size: 260, baseHue: 40,  hueSpeed: 20, speed: 0.31 },
];

function useBlobStyle(config: BlobConfig, time: Animated.SharedValue<number>) {
  return useAnimatedStyle(() => {
    'worklet';
    const t = time.value;
    const x = config.centerX + config.radiusX * Math.sin(config.a * t * config.speed + config.delta);
    const y = config.centerY + config.radiusY * Math.sin(config.b * t * config.speed);
    const hue = Math.round((config.baseHue + t * config.hueSpeed) % 360);
    const scale = 1 + 0.08 * Math.sin(t * 0.7);
    return {
      transform: [
        { translateX: x - config.size / 2 },
        { translateY: y - config.size / 2 },
        { scale },
      ],
      backgroundColor: `hsl(${hue}, 85%, 55%)`,
    };
  });
}

export function AnimatedBackground() {
  const time = useSharedValue(0);

  useEffect(() => {
    // Drive time from 0 → 86400 (one full day in seconds) over 24 hours.
    // Linear, never loops, effectively infinite. Runs entirely on UI thread.
    time.value = withTiming(86400, { duration: 86400_000, easing: Easing.linear });
  }, []);

  const style0 = useBlobStyle(BLOBS[0], time);
  const style1 = useBlobStyle(BLOBS[1], time);
  const style2 = useBlobStyle(BLOBS[2], time);
  const style3 = useBlobStyle(BLOBS[3], time);

  const blobStyles = [style0, style1, style2, style3];

  return (
    <View style={styles.container} pointerEvents="none">
      {BLOBS.map((config, i) => (
        <Animated.View
          key={i}
          style={[
            {
              position: 'absolute',
              width: config.size,
              height: config.size,
              borderRadius: config.size / 2,
              opacity: 0.22,
            },
            blobStyles[i],
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a0a0f',
    overflow: 'hidden',
  },
});
