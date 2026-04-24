/**
 * Ensures JAVA_HOME on Windows before `expo run:android` (Gradle still reads gradlew.bat).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

if (!process.env.JAVA_HOME && process.platform === "win32") {
  const jbr = path.join(
    process.env.ProgramFiles || "C:\\Program Files",
    "Android",
    "Android Studio",
    "jbr",
  );
  if (fs.existsSync(path.join(jbr, "bin", "java.exe"))) {
    process.env.JAVA_HOME = jbr;
  }
}

// Restrict Gradle to a single native ABI to cut ~4x off native compile/pack.
// Override with R2D3_ABI=x86_64 (emulator) or R2D3_ABI=arm64-v8a,x86_64 etc.
// Gradle auto-maps ORG_GRADLE_PROJECT_<name> env vars to -P<name>=..., which
// is the only reliable way to pass properties through `expo run:android`
// (its CLI does not forward arbitrary gradle args).
const abi = process.env.R2D3_ABI || "arm64-v8a";
const childEnv = {
  ...process.env,
  ORG_GRADLE_PROJECT_reactNativeArchitectures: abi,
};

const r = spawnSync("npx", ["expo", "run:android", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: childEnv,
  shell: true,
});

process.exit(r.status == null ? 1 : r.status);
