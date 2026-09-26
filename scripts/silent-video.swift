// Local media processing only. This program never captures a screen or sound.
// Keep source video timing/orientation while excluding every audio/data track.
import AVFoundation
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count >= 3 else { fail("Use strip <source> <output.mov> or verify <video>.") }
let operation = CommandLine.arguments[1]
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[2])
let source = AVURLAsset(url: sourceURL)
let videoTracks = source.tracks(withMediaType: .video)
guard videoTracks.count == 1 else { fail("The recording must contain exactly one video track; no track was guessed.") }

if operation == "strip" {
    guard CommandLine.arguments.count == 4 else { fail("Provide a new silent output path.") }
    let destination = URL(fileURLWithPath: CommandLine.arguments[3])
    guard !FileManager.default.fileExists(atPath: destination.path) else { fail("Silent output already exists.") }
    let original = videoTracks[0]
    let composition = AVMutableComposition()
    guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail("Could not create the video-only composition.") }
    do {
        // Inserting at the original start preserves the source timeline for the
        // caller's subsequent explicit --start / --duration selection.
        try video.insertTimeRange(original.timeRange, of: original, at: original.timeRange.start)
    } catch { fail("Could not copy the original video track: \(error.localizedDescription)") }
    video.preferredTransform = original.preferredTransform
    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else { fail("Could not export the silent composition.") }
    exporter.outputURL = destination
    exporter.outputFileType = .mov
    exporter.metadata = []
    let done = DispatchSemaphore(value: 0)
    exporter.exportAsynchronously { done.signal() }
    if done.wait(timeout: .now() + 600) != .success { exporter.cancelExport(); fail("Silent-video export timed out.") }
    guard exporter.status == .completed else { fail("Silent-video export failed: \(exporter.error?.localizedDescription ?? "unknown media error")") }
    let output = AVURLAsset(url: destination)
    guard output.tracks(withMediaType: .audio).isEmpty, output.tracks(withMediaType: .video).count == 1 else { fail("The silent intermediate failed its track check.") }
    print("Video-only intermediate created.")
} else if operation == "verify" {
    guard CommandLine.arguments.count == 3 else { fail("Verify accepts exactly one video file.") }
    let audioCount = source.tracks(withMediaType: .audio).count
    guard audioCount == 0 else { fail("The converted video unexpectedly contains audio; it will not be accepted.") }
    let seconds = source.duration.seconds
    guard seconds.isFinite && seconds > 0 else { fail("The converted video has no valid positive duration.") }
    let report: [String: Any] = ["audioTracks": audioCount, "videoTracks": videoTracks.count, "durationSeconds": seconds]
    do { print(String(data: try JSONSerialization.data(withJSONObject: report), encoding: .utf8)!) }
    catch { fail("Could not serialize the media inspection result.") }
} else { fail("Unknown operation. Use strip or verify.") }
