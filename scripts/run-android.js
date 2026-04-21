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

const r = spawnSync("npx", ["expo", "run:android", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  shell: true,
});

process.exit(r.status == null ? 1 : r.status);
