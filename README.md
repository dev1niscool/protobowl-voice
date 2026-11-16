# ProtoBowl Voice

Chrome and Safari extensions that read ProtoBowl questions aloud, with word-paced reading and an optional **Natural flow** mode for complete sentences. No account, API key, or subscription is required.

## Install in Chrome

Download `protobowl-voice-1.2.0.zip` from this repository's **Releases** page and extract it, or download the source code.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the `extension` folder in this project.
4. Refresh your existing ProtoBowl tabs, or open [ProtoBowl](https://protobowl.com/) and join a room.
5. Pin **ProtoBowl Voice** from Chrome's Extensions menu. Open it to choose a voice and press **Test**.

If using the release ZIP, select the extracted folder containing `manifest.json` at step 3. Keep that folder in place while the extension is installed.

## Install in Safari on Mac

Requires **Safari 18 or later** on **macOS 13 or later**. The Mac app supports both Apple silicon and Intel. This release is an **unsigned development distribution**: it has no Apple Developer identity or notarization. Safari requires **Allow unsigned extensions** to run it. An ad-hoc integrity signature is included for macOS, without a certificate or team identifier. It is not an App Store release or an iPhone/iPad installation package.

1. Download `protobowl-voice-safari-macos-1.2.0.zip` from **Releases** and extract it.
2. Move **ProtoBowl Voice.app** to Applications and open it once. If macOS blocks the downloaded app, use the source-build option below or your Mac's **Privacy & Security > Open Anyway** control after reviewing the source.
3. In Safari, open **Settings > Advanced**, then enable **Show features for web developers** (older versions call this **Show Develop menu**).
4. In **Settings > Developer**, select **Allow unsigned extensions**. Some versions put this option in the **Develop** menu. Safari may reset it when it quits.
5. Open **Settings > Extensions**, enable **ProtoBowl Voice**, and allow access to `protobowl.com`.
6. Refresh ProtoBowl. Click **Start the Question**, another room control, or the small **Voice · Click to start** button once to allow speech on that page. Open the toolbar popup to select a voice, test it, or enable **Natural flow**.

If your Safari offers **Settings > Developer > Add Temporary Extension**, you can instead extract `protobowl-voice-safari-extension-1.2.0.zip` and select its folder containing `manifest.json`. Temporary installations may be removed when Safari quits. The runtime ZIP cannot be installed by double-clicking it.

To build the Mac app yourself, install Xcode, download the source, and run:

```sh
python3 scripts/package.py
python3 scripts/build-safari.py
```

The generated app and ZIP are in `dist`. The build uses a generic product bundle identifier, no developer team, and no provisioning profile. Xcode's generated project stays in `dist` and is excluded from published source. See Apple's [Safari distribution options](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension).

## Use

Reading is enabled by default. **Automatic** favors natural/enhanced English voices and local voices with word-timing events. Available voices and their quality depend on the operating system and installed speech engines. You can install additional voices in your operating system's speech settings and reopen the popup to refresh the list.

- **Speech pace:** adjusts speed relative to the automatic room-speed estimate. Start at **1.00×**.
- **Timing adjustment:** positive values start speech earlier; negative values start it later. The default is **80 ms earlier**, in addition to the estimated duration needed to finish the first word at its reveal.
- **Volume:** controls extension speech.
- **Read along:** turns reading on or off. The small **Voice** button in the room also toggles it.
- **Natural flow:** off by default. Turn it on to speak each complete sentence in one continuous utterance, aiming to finish when its final word appears. The voice chooses the rhythm and pauses inside the sentence; individual words are no longer aligned to their reveals. The pace is chosen once per sentence, and the timing slider adjusts its finish target. Very fast rooms still require faster speech. After joining midway or a buzz, reading resumes with the remaining part of the sentence.

Speech stops for buzzes, room pauses, finished questions, navigation, and inactive tabs. After a pause or when joining midway, it resumes near the current word instead of reciting old clues. Settings apply to all ProtoBowl tabs. Use one active ProtoBowl tab for listening.

## Timing and naturalness

The extension reads the question and reveal schedule already present in ProtoBowl's browser client. The default mode uses upcoming words in short phrases. Natural flow uses the rest of the current sentence to preserve its phrasing and targets the final word's reveal time. This means some words may be heard before or after their own visual reveals. It estimates speech duration and learns startup latency and speech speed from playback events. It never changes the room's reveal speed or buzz rules.

**Word and sentence finish targets are approximate; exact synchronization or multiplayer fairness cannot be guaranteed.** Chrome TTS and Safari’s Web Speech API provide playback events and a rate control, not exact word durations or a sample-accurate scheduling interface. Speech may land a little early or late, especially on the first utterance, unusual names, very fast rooms, or voices that lack timing events. The default mode's short phrase boundaries can be audible; Natural flow avoids those breaks within ordinary sentences. Extremely long text exceeding the 32,000-character utterance limit is split at a word boundary. A lower room speed generally makes speech easier to follow; the extension does not change it for you. The maximum speech rate is 3.5×.

To update an existing unpacked installation, replace its files with the new release, click **Reload** on its card at `chrome://extensions`, and refresh ProtoBowl. Existing settings are preserved and Natural flow starts off until enabled.

The implementation uses the live ProtoBowl client's room interface. If the site changes that interface, the extension stops reading and reports that it is waiting instead of guessing from unrelated page text.

## Privacy and permissions

Chrome permissions are limited to **storage**, **tts**, and content scripts on `protobowl.com` and its subdomains. Safari uses **storage** and the same site access; speech runs in the room using Web Speech. The extension does not read answers, chat, credentials, or other sites. It makes no network requests and contains no analytics or external scripts. Settings stay in local extension storage. Question text is sent to the selected speech engine; voices marked **online** may process text remotely under that engine's policy. Choose a local voice for on-device synthesis.

Published files contain no personal account name, email, home-directory path, machine identifier, Apple developer team, provisioning profile, or signing certificate. Git commits use a generic author. Product identifiers needed by Safari are generic and shared by all installations. Packaged extension and app ZIPs use fixed timestamps and omit local filesystem metadata. The Mac package also omits unused asset catalogs that can contain incidental build timestamps. GitHub-generated source archives retain ordinary commit hashes and commit timestamps. GitHub still identifies the repository owner and release publisher.

## Development and verification

Requires Node 18+ for tests and Python 3 for packaging. Building the Safari Mac app additionally requires Xcode. Installing a prebuilt release requires neither Node nor Python.

```sh
npm test
python3 scripts/package.py
```

The automated tests cover the real page adapter, scheduling bounds, UTF-16 word offsets, settings validation, cancellation races, buzz/pause/resume, and speech ownership. Browser smoke testing loaded the unpacked extension in Chrome for Testing against a dedicated live ProtoBowl room, verified voice enumeration and real TTS callbacks, and exercised buzz interruption. Audio was muted for that automated Chrome check. Safari verification exercised the packaged Mac app, saved Natural flow setting, live ProtoBowl reading, pause/resume, and buzz interruption. A separate muted Safari fixture verified real Web Speech start, word, and completion callbacks. These checks verify integration, not subjective voice quality or an exact audible alignment guarantee.

The runtime is intentionally dependency-free:

- `bridge.js`: read-only page-world adapter for ProtoBowl's room clock.
- `core.js`: pure phrase planning, duration estimation, validation, and voice ranking.
- `content.js`: synchronization, pause/buzz handling, and room status control.
- `background.js`: Chrome TTS ownership and playback events.
- `popup.*`: voice preview and saved controls.
- `safari/speech.js`: Safari speech, browser events, and audio activation.
- `safari/background.js` and `safari/popup-transport.js`: Safari tab status and preview coordination.
- `scripts/build-safari.py`: anonymous local Mac app build and packaging.

References: [Chrome TTS API](https://developer.chrome.com/docs/extensions/reference/api/tts), [content script execution worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), and [ProtoBowl source](https://github.com/neotenic/protobowl).
