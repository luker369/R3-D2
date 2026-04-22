const { withDangerousMod, withMainApplication, AndroidConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Recreates the native AudioStreamModule that was previously hand-written in
// android/. Since android/ is gitignored, prebuild --clean wiped it; this
// plugin regenerates the Kotlin source and registers the package so that
// services/audio-stream.ts has a native module to call.
//
// Contract (see services/audio-stream.ts):
//   start(path: String): Promise<boolean>
//   stop(): Promise<{durationMs: number, bytes: number}>
//   isActive(): Promise<boolean>
//   event "R2AudioFrame" -> {dbfs: number, ts: number}

function withNativeSource(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const packageName = AndroidConfig.Package.getPackage(config);
      if (!packageName) throw new Error('[with-audio-stream] Android package not set');
      const packagePath = packageName.replace(/\./g, '/');
      const javaDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java',
        packagePath,
      );
      await fs.promises.mkdir(javaDir, { recursive: true });

      const moduleKt = `package ${packageName}

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

class AudioStreamModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "AudioStreamModule"
    private const val SAMPLE_RATE = 16000
    private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
    private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    private const val FRAME_EMIT_MS = 100L
  }

  private val running = AtomicBoolean(false)
  private var captureThread: Thread? = null
  private var currentFile: RandomAccessFile? = null
  private var currentPath: String? = null
  private var startNs: Long = 0L
  private var bytesWritten: Long = 0L
  private var lastDurationMs: Long = 0L
  private var lastBytes: Long = 0L

  override fun getName(): String = "AudioStreamModule"

  @ReactMethod
  fun start(filePath: String, promise: Promise) {
    if (running.get()) {
      promise.resolve(true)
      return
    }
    try {
      val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
      if (minBuf <= 0) {
        promise.resolve(false)
        return
      }
      val bufSize = max(minBuf, SAMPLE_RATE * 2 / 5) // ~200ms
      val recorder = AudioRecord(
          MediaRecorder.AudioSource.MIC,
          SAMPLE_RATE,
          CHANNEL,
          ENCODING,
          bufSize,
      )
      if (recorder.state != AudioRecord.STATE_INITIALIZED) {
        recorder.release()
        promise.resolve(false)
        return
      }

      val raf = RandomAccessFile(filePath, "rw")
      raf.setLength(0)
      writeWavHeaderPlaceholder(raf)
      currentFile = raf
      currentPath = filePath
      bytesWritten = 0L
      startNs = System.nanoTime()

      recorder.startRecording()
      running.set(true)

      captureThread = Thread({ captureLoop(recorder, bufSize) }, "R2AudioCapture").also {
        it.isDaemon = true
        it.start()
      }
      promise.resolve(true)
    } catch (e: Throwable) {
      Log.w(TAG, "start failed", e)
      running.set(false)
      try { currentFile?.close() } catch (_: Throwable) {}
      currentFile = null
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    if (!running.get()) {
      val map = Arguments.createMap()
      map.putDouble("durationMs", lastDurationMs.toDouble())
      map.putDouble("bytes", lastBytes.toDouble())
      promise.resolve(map)
      return
    }
    running.set(false)
    try { captureThread?.join(500) } catch (_: Throwable) {}
    captureThread = null

    val durationMs = (System.nanoTime() - startNs) / 1_000_000L
    val bytes = bytesWritten
    try {
      currentFile?.let { finalizeWavHeader(it, bytes) }
    } catch (e: Throwable) {
      Log.w(TAG, "finalize failed", e)
    } finally {
      try { currentFile?.close() } catch (_: Throwable) {}
      currentFile = null
    }
    lastDurationMs = durationMs
    lastBytes = bytes
    val map = Arguments.createMap()
    map.putDouble("durationMs", durationMs.toDouble())
    map.putDouble("bytes", bytes.toDouble())
    promise.resolve(map)
  }

  @ReactMethod
  fun isActive(promise: Promise) {
    promise.resolve(running.get())
  }

  @ReactMethod
  fun addListener(eventName: String) { /* RN event emitter requirement */ }

  @ReactMethod
  fun removeListeners(count: Int) { /* RN event emitter requirement */ }

  private fun captureLoop(recorder: AudioRecord, bufSize: Int) {
    val buf = ByteArray(bufSize)
    var lastEmit = 0L
    try {
      while (running.get()) {
        val n = recorder.read(buf, 0, buf.size)
        if (n <= 0) continue
        try {
          currentFile?.write(buf, 0, n)
          bytesWritten += n
        } catch (e: Throwable) {
          Log.w(TAG, "write failed, stopping", e)
          running.set(false)
          break
        }
        val now = System.currentTimeMillis()
        if (now - lastEmit >= FRAME_EMIT_MS) {
          lastEmit = now
          emitFrame(buf, n, now)
        }
      }
    } finally {
      try { recorder.stop() } catch (_: Throwable) {}
      try { recorder.release() } catch (_: Throwable) {}
    }
  }

  private fun emitFrame(buf: ByteArray, n: Int, tsMs: Long) {
    val samples = n / 2
    if (samples <= 0) return
    val bb = ByteBuffer.wrap(buf, 0, n).order(ByteOrder.LITTLE_ENDIAN)
    var sumSq = 0.0
    var i = 0
    while (i < samples) {
      val s = bb.short.toInt()
      sumSq += (s * s).toDouble()
      i++
    }
    val rms = sqrt(sumSq / samples.toDouble())
    val dbfs = if (rms < 1.0) -120.0 else 20.0 * log10(rms / 32768.0)
    val map = Arguments.createMap()
    map.putDouble("dbfs", dbfs)
    map.putDouble("ts", tsMs.toDouble())
    try {
      reactApplicationContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("R2AudioFrame", map)
    } catch (_: Throwable) {
      // JS not ready — silently drop
    }
  }

  private fun writeWavHeaderPlaceholder(raf: RandomAccessFile) {
    val header = ByteArray(44)
    raf.seek(0)
    raf.write(header)
  }

  private fun finalizeWavHeader(raf: RandomAccessFile, dataBytes: Long) {
    val byteRate = SAMPLE_RATE * 1 * 16 / 8
    val blockAlign: Short = (1 * 16 / 8).toShort()
    val totalDataLen = dataBytes + 36
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray(Charsets.US_ASCII))
    header.putInt(totalDataLen.toInt())
    header.put("WAVE".toByteArray(Charsets.US_ASCII))
    header.put("fmt ".toByteArray(Charsets.US_ASCII))
    header.putInt(16)
    header.putShort(1.toShort())
    header.putShort(1.toShort())
    header.putInt(SAMPLE_RATE)
    header.putInt(byteRate)
    header.putShort(blockAlign)
    header.putShort(16.toShort())
    header.put("data".toByteArray(Charsets.US_ASCII))
    header.putInt(dataBytes.toInt())
    raf.seek(0)
    raf.write(header.array())
  }
}
`;

      const packageKt = `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AudioStreamPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(AudioStreamModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}
`;

      await fs.promises.writeFile(path.join(javaDir, 'AudioStreamModule.kt'), moduleKt);
      await fs.promises.writeFile(path.join(javaDir, 'AudioStreamPackage.kt'), packageKt);
      return config;
    },
  ]);
}

function withPackageRegistration(config) {
  return withMainApplication(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error('[with-audio-stream] expected MainApplication.kt');
    }
    let src = config.modResults.contents;
    if (src.includes('AudioStreamPackage()')) {
      return config; // already applied
    }
    // Inject add(AudioStreamPackage()) inside the `.apply { }` block of getPackages().
    const anchor = 'PackageList(this).packages.apply {';
    if (!src.includes(anchor)) {
      throw new Error('[with-audio-stream] could not find PackageList apply anchor');
    }
    src = src.replace(
      anchor,
      `${anchor}\n              add(AudioStreamPackage())`,
    );
    config.modResults.contents = src;
    return config;
  });
}

module.exports = function withAudioStream(config) {
  config = withNativeSource(config);
  config = withPackageRegistration(config);
  return config;
};
