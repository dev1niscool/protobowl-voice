# ProtoBowl Voice

A Chrome extension that reads ProtoBowl questions aloud, with word-paced reading and an optional **Natural flow** mode for complete sentences. No build step, account, API key, or subscription is required.

## Install in Chrome

Download `protobowl-voice-1.1.0.zip` from this repository's **Releases** page and extract it, or download the source code.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the `extension` folder in this project.
4. Refresh your existing ProtoBowl tabs, or open [ProtoBowl](https://protobowl.com/) and join a room.
5. Pin **ProtoBowl Voice** from Chrome's Extensions menu. Open it to choose a voice and press **Test**.

If using the release ZIP, select the extracted folder containing `manifest.json` at step 3. Keep that folder in place while the extension is installed.

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

**Word and sentence finish targets are approximate; exact synchronization or multiplayer fairness cannot be guaranteed.** Chrome TTS provides playback events and a rate control, not exact word durations or a sample-accurate scheduling interface. Speech may land a little early or late, especially on the first utterance, unusual names, very fast rooms, or voices that lack timing events. The default mode's short phrase boundaries can be audible; Natural flow avoids those breaks within ordinary sentences. Extremely long text exceeding the 32,000-character utterance limit is split at a word boundary. A lower room speed generally makes speech easier to follow; the extension does not change it for you. The maximum speech rate is 3.5×.

To update an existing unpacked installation, replace its files with the new release, click **Reload** on its card at `chrome://extensions`, and refresh ProtoBowl. Existing settings are preserved and Natural flow starts off until enabled.

The implementation uses the live ProtoBowl client's room interface. If the site changes that interface, the extension stops reading and reports that it is waiting instead of guessing from unrelated page text.

## Privacy and permissions

Permissions are limited to **storage**, **tts**, and content scripts on `protobowl.com` and its subdomains. The extension does not read answers, chat, credentials, or other sites. It makes no network requests and contains no analytics or external scripts. Settings stay in local Chrome storage. Question text is sent to the selected speech engine; voices marked **online** may process text remotely under that engine's policy. Choose a local voice for on-device synthesis.

## Development and verification

Requires Node 18+ only for tests; Python 3 only for packaging. Chrome installation requires neither.

```sh
npm test
python3 scripts/package.py
```

The automated tests cover the real page adapter, scheduling bounds, UTF-16 word offsets, settings validation, cancellation races, buzz/pause/resume, and speech ownership. Browser smoke testing loaded the unpacked extension in Chrome for Testing against a dedicated live ProtoBowl room, verified voice enumeration and real TTS callbacks, and exercised buzz interruption. Audio was muted for that automated check: it verifies integration, not subjective voice quality or an exact audible alignment guarantee.

The runtime is intentionally dependency-free:

- `bridge.js`: read-only page-world adapter for ProtoBowl's room clock.
- `core.js`: pure phrase planning, duration estimation, validation, and voice ranking.
- `content.js`: synchronization, pause/buzz handling, and room status control.
- `background.js`: Chrome TTS ownership and playback events.
- `popup.*`: voice preview and saved controls.

References: [Chrome TTS API](https://developer.chrome.com/docs/extensions/reference/api/tts), [content script execution worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), and [ProtoBowl source](https://github.com/neotenic/protobowl).
