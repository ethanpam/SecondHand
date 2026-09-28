# iPhone autofill QA videos

## Live Safari — September 27, 2026

[Watch/download the live Safari MP4](iphone-live-safari-demo.mp4)

Duration: **6:33**. Portrait video: **588 × 1280**, H.264, **14.3 MB**, silent. This is an uninterrupted recording of the actual Simulator, including operator pauses; decoded frames were visually inspected.

The recording shows the installed Safari extension on **SecondHand AutoApply QA**, an iPhone Simulator running iOS 26.5, filling Iowa's real **Enter Personal Information** page. It begins with the saved profile and sharing disclosure, then resets an earlier unsaved partial form through an ordinary Safari reload. From the freshly reloaded blank form, one **Start application assistance** action selects home-address **Yes** and fills **10 fields**: first/middle/last name, home/mobile phone, street, unit, city, state, and ZIP. The popup reports **“Home address Yes selected. 10 fields filled.”** The filled values were visually verified after the popup closed.

Approximate landmarks:

- **0:00** — saved native profile; **0:40** — sharing disclosure.
- **2:29** — blank phone fields and unanswered home-address choice after reload.
- **3:44** — extension Start screen; **4:27** — automatic Yes and ten-field success message.
- **5:27** — filled address; **5:55** — phones; **6:27** — names.

This verifies the real encrypted native sharing snapshot → installed Safari extension → live website. The user approved fictional **Avery Jordan Example** data with awareness of possible autosaving and completed CAPTCHA and consent. The signed Debug app used the approved Simulator-only `--ui-testing` bypass without `--offline-qa`. No applicant **Save and Continue**, signature, or submission was performed; physical hardware and the complete application workflow remain untested.

The final signed Debug build, **20 native tests**, and **97 JavaScript tests** passed. An intermediate scroll-settling issue was fixed before this successful ten-field run. See the [validation report](../Validation.md#live-iphone-safari-autofill--september-27-2026) for the test boundary and remaining checks.

MP4 SHA-256: `d36fe10ebb50d35d1f668a729fa91d0bda3c7a34bc6b9fd4531647591df57552`.

## Earlier offline demo — September 27, 2026

[Watch/download the offline MP4](iphone-autofill-demo.mp4)

Recorded September 27, 2026, on the isolated **SecondHand AutoApply QA** iPhone Simulator, iOS 26.5. Duration: **3:35**. Portrait video: **588 × 1280**, H.264, approximately **6 MB**, silent. This is an uninterrupted recording of the actual running app; it includes pauses while operating the UI.

### What the offline recording shows

1. The saved fictional **Avery Jordan Example** profile in Second Hand.
2. Explicit approval of the normal ten-minute application-sharing snapshot.
3. A blank **offline replica** of the inspected Iowa applicant form.
4. **Fill saved details** populating first/middle/last name and both phone numbers: **5 filled, 0 skipped**.
5. A manual **Yes** answer to the local home-address question, revealing empty address controls.
6. A second fill populating street, unit, city, state, and ZIP: **5 filled, 0 skipped; 10 saved fields present**.

The data comes from the real encrypted App Group snapshot through `SecureVault.readAutofillSession()`. The WebKit view runs the unchanged production field mapper, Iowa adapter, address policy, and application assistant. No field values or successful outcomes are scripted into the recording. Native diagnostics reported `unsupportedUntouched: true` for the asserted suffix, maiden-name, mailing-address-choice, applicant-choice, and program-choice controls on both fills.

This verifies **saved native profile → encrypted sharing snapshot → production JavaScript → actual WebKit fields**. The QA view is inside the iPhone app; it is not the Safari extension popup and does not validate Safari native messaging. The form is reconstructed from public metadata, not a pixel-exact copy of Iowa's site. This offline recording does not test login, CAPTCHA, live saving/submission, later application pages, physical-device authentication, or SNAP renewal. The separately authorized [live Safari follow-up](../Validation.md#live-iphone-safari-autofill--september-27-2026) records installed-extension results and remaining issues.

### Replay the offline demo locally

Use an isolated Simulator with fictional data only. In Xcode, select the **SecondHand** scheme, **Debug**, and an iPhone Simulator. Keep local signing enabled. Add both launch arguments:

```text
--ui-testing
--offline-qa
```

The authentication bypass and QA view are compiled only for Debug Simulator builds. The QA tab and its executable code are unavailable on physical devices and in Release. Inert bundled fixture resources are present in Release.

Save and confirm a fake profile through **Profile**. Enable **Settings → Allow application sharing for 10 minutes**, then open **QA demo**. Click **Fill saved details**, review the name and phone fields, select **Yes** for a home address in the local form, and fill again. Restart the app to reset the replica; the saved profile persists.

The local fixture's Content Security Policy blocks external resources, connections, and form submission. Native navigation cancellation prevents leaving the fixture, its web data store is nonpersistent, and Back/Save controls are disabled. The official URL is supplied only as the in-memory document's base URL so production URL checks can run unchanged; it is never requested by this view. Production website permissions and URL restrictions were not expanded.

### Rebuild and record the offline demo

From the repository root, with the pinned Node dependencies installed:

```sh
node ios/scripts/export-applicant-qa-fixture.cjs --check
python3 ios/scripts/generate_project.py
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/SecondHand.xcodeproj -scheme SecondHand -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios-video-qa CODE_SIGN_IDENTITY=- build
```

If the shared form fixture changes, regenerate it by omitting `--check`. The exporter retains the inspected 29-control schema. Install and launch the build on your QA Simulator, then record with its UDID:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl io YOUR_QA_SIMULATOR_UDID \
  recordVideo --codec=h264 --mask=black /private/tmp/secondhand-ios-qa-raw.mov
```

Wait for `Recording started`, perform the UI steps, press **Control-C**, and wait for the file to finalize. Convert and inspect the real frames:

```sh
/usr/bin/avconvert --source /private/tmp/secondhand-ios-qa-raw.mov \
  --preset Preset1280x720 --output /private/tmp/iphone-autofill-demo.mp4 --replace --progress
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swift \
  ios/scripts/inspect-qa-video.swift /private/tmp/iphone-autofill-demo.mp4 \
  /private/tmp/iphone-video-review
```

Validation for this recording: signed Debug and Release Simulator builds passed; **82/82** existing iOS JavaScript tests passed; generated fixture check passed; actual video frames were decoded and visually inspected. Release build success does not validate physical-device signing or authentication.

MP4 SHA-256: `0cdae6507c5286ec8cb7caa5668eef38180151f2e833aadea57045f40f800da6`.
