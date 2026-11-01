# Android Emulators and phones

> **Applies to:** macOS on Apple silicon (host, standby or desktop). The steps below
> are for macOS. On a Linux desktop, use Android Studio or Google's command-line tools
> in your own account.

The Android SDK goes in the account that runs the emulators: the host's agent account
for host threads, `agent-standby` for the standby lane, and your own account for
Local threads. Neither `install.sh` nor the Device panel installs it. It needs a real
Mac, because macOS VMs have no nested virtualization
([virtual machines](virtual-machines.md)).

The server looks for an SDK in the account's `~/Library/Android/sdk`, then through
`adb` on its `PATH`. It never sees an `ANDROID_HOME` set in `~/.zprofile`. A server
started over SSH takes only `PATH` and `JAVA_HOME` from the login shell, and the
desktop's Local server gets `PATH` but not `JAVA_HOME`. So the SDK goes in that folder.

- **Homebrew's `android-commandlinetools`, not Android Studio.** Android Studio's
  setup wizard, SDK Manager and Device Manager are windows that install into the
  account running them. So every agent account would need its own login at the
  screen. An SDK in your admin account's home is closed to agent accounts. You install
  the cask once, into Homebrew's folder, which every account can read. Each account
  then runs its `sdkmanager` over SSH to install its own SDK. The cask's default SDK
  root is inside Homebrew's folder, which agent accounts can't write, so each
  `sdkmanager` line passes `--sdk_root`. Android Studio works fine for your own
  account.
- **Java 17.** `avdmanager`, which the device hub runs, and Homebrew's `sdkmanager` are
  Java 17 programs. React Native recommends JDK 17 for builds. Homebrew's `openjdk@17`
  isn't on the `PATH` by itself. So each account sets `JAVA_HOME`, and it puts the
  JDK's `bin` on its `PATH` for the Local server.
- **One account per Mac runs emulators.** adb doesn't separate accounts. A Mac has one
  adb server, on port 5037. It connects to every emulator on the Mac's loopback ports
  5554 to 5585, whichever account started the emulator.

## Install

Run this once per Mac, from your admin account. `ffmpeg` with libx264 is for emulator
video.

```sh
brew install --cask android-commandlinetools
brew install openjdk@17 ffmpeg
```

Then run the following as the account that runs the emulators. Reach that account with
`ssh agent-claude@localhost` or `ssh -p 2222 agent-standby@127.0.0.1`, or use Terminal
in your own account.

```sh
cat >> ~/.zprofile <<'EOF'
# Android: this account's own SDK, where T3 looks for it; JDK 17; the SDK's tools ahead of Homebrew's.
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin:$PATH"
EOF
exec zsh -l
```

```sh
sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "cmdline-tools;latest" "platform-tools" "emulator" "platforms;android-36" "system-images;android-36;google_apis;arm64-v8a"
exec zsh -l
```

Read each license and answer `y`. Then find the tools and create a virtual device:

```sh
command -v sdkmanager avdmanager adb emulator
echo no | avdmanager create avd -n Pixel -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_8
```

Each tool should be under `~/Library/Android/sdk`.

- **API 36 is an example.** API 36 is Android 16. Install the platform your projects
  compile against, and the image for it. `sdkmanager --sdk_root="$ANDROID_HOME" --list`
  shows them. Apple silicon needs an `arm64-v8a` image. The API 36 Google APIs image
  carries a July 2025 security patch level. For a current patch level, test on the
  newest image too. In October 2026 that's
  `system-images;android-37.2;google_apis_ps16k;arm64-v8a`, with
  `platforms;android-37.2`. Package names differ by API level. Google APIs images
  allow `adb root`, and Play Store images don't.
- The first `sdkmanager` you run is Homebrew's. Once `cmdline-tools;latest` is
  installed, the account's own copy comes first. From Command-line Tools 23 on,
  `sdkmanager` hands its work to Google's new `android` command, and `--licenses` only
  prints that it's no longer needed. The package names stay the same.
- `-d pixel_8` is a profile from `avdmanager list device -c`. The `echo no` answers
  avdmanager's custom hardware question. The virtual device goes in that account's
  `~/.android/avd`. The downloads come to about 2.5 GB per account, and about 6 GB on
  disk. `sdkmanager --sdk_root="$ANDROID_HOME" --update` keeps them current.

## Check

Run this from your admin account. For the standby lane, use
`ssh -p 2222 agent-standby@127.0.0.1` instead of `ssh agent-claude@localhost`. The
check boots the emulator with the flags the device hub starts emulators with. It uses a
port of its own, so it can't touch another emulator.

```sh
ssh agent-claude@localhost zsh -l -s <<'EOF'
java -version 2>&1 | head -1
command -v adb emulator avdmanager
emulator -list-avds
emulator -avd Pixel -port 5584 -no-audio -no-window -gpu auto -no-boot-anim >~/emulator-check.log 2>&1 &
booted=0
for i in {1..90}; do
  [[ "$(adb -s emulator-5584 shell getprop sys.boot_completed 2>/dev/null)" == 1* ]] && { booted=1; break; }
  sleep 2
done
if (( booted )); then echo "BOOTED emulator-5584"; else echo "NOT BOOTED after 180 s: see ~/emulator-check.log"; fi
adb -s emulator-5584 emu kill
EOF
```

It prints `openjdk version "17…"`, the three tools under `~/Library/Android/sdk`,
`Pixel`, and `BOOTED emulator-5584`. A cold boot takes about 80 seconds. If it prints
`NOT BOOTED`, that account's `~/emulator-check.log` says why. Read it with
`ssh agent-claude@localhost cat emulator-check.log`. If the boot works only while the
account is logged in at the screen, keep it logged in there, as for
[iOS](ios.md#simulators).

After you change an account's tools, switch its environment off and on. For Local,
quit and reopen the app. Start emulators from the Device panel. An emulator started by
hand shows "No video received from the device".

## Android phone

On the phone, open **Settings → About phone** and tap **Build number** seven
times. Then turn on **USB debugging** in **Developer options**. Connect the phone to
the Mac whose environment uses it, and accept the computer's key on the phone.
`ssh agent-claude@localhost 'adb devices'` lists it as `device`. Upstream streams
physical Android devices with scrcpy. Don't use wireless debugging (`adb pair`,
`adb tcpip`), because it opens adb to your local network. This hasn't been tried with
blacksand-t3 yet.
