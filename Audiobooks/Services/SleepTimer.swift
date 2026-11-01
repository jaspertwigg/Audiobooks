import AudioToolbox
import Foundation
import Observation
import UIKit

/// Pauses playback after a set time (or at the end of the current chapter).
///
/// - The countdown only runs while audio is actually playing.
/// - The volume fades out over the last few seconds.
/// - Shaking the phone while the timer is running adds the original duration again
///   (e.g. a 15-minute timer with 2 minutes left becomes 17 minutes). Works with the screen locked.
@MainActor
@Observable
final class SleepTimer {
    enum Mode: Equatable {
        case off
        case duration
        case endOfChapter
    }

    private(set) var mode: Mode = .off
    /// The duration the timer was started with; a shake adds this much again.
    private(set) var originalDuration: TimeInterval = 0
    /// Seconds of listening left before playback pauses.
    private(set) var remaining: TimeInterval = 0
    /// Changes every time the timer is extended (the UI shows a confirmation).
    private(set) var extensionCount = 0
    private(set) var isFading = false

    var isActive: Bool { mode != .off }

    static let fadeDuration: TimeInterval = 15

    @ObservationIgnored private let player: PlayerEngine
    @ObservationIgnored private let shakeDetector = ShakeDetector()
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var lastTick = Date()
    @ObservationIgnored private var chapterEndTarget: Double = 0

    init(player: PlayerEngine) {
        self.player = player
        shakeDetector.onShake = { [weak self] in
            self?.handleShake()
        }
    }

    // MARK: - Control

    func start(duration: TimeInterval) {
        mode = .duration
        originalDuration = duration
        remaining = duration
        UserDefaults.standard.set(duration, forKey: "lastSleepDuration")
        begin()
    }

    func startEndOfChapter() {
        guard let chapter = player.currentChapter else { return }
        mode = .endOfChapter
        originalDuration = 0
        chapterEndTarget = chapter.end
        remaining = max(0, (chapterEndTarget - player.livePosition) / Double(player.rate))
        begin()
    }

    func cancel() {
        stopTimer()
        player.setVolume(1)
    }

    /// Adds the original duration again (or, in end-of-chapter mode, moves on to the next chapter's end).
    func extend() {
        switch mode {
        case .off:
            return
        case .duration:
            remaining += originalDuration
        case .endOfChapter:
            let next = player.chapters.first { $0.start >= chapterEndTarget - 0.5 }
            chapterEndTarget = next?.end ?? player.duration
            remaining = max(0, (chapterEndTarget - player.livePosition) / Double(player.rate))
        }
        isFading = false
        player.setVolume(1)
        extensionCount += 1
        confirmWithHaptic()
    }

    var shakeHint: String {
        switch mode {
        case .off: return ""
        case .duration: return "Shake to add \(TimeFormat.minutes(originalDuration))"
        case .endOfChapter: return "Shake to continue to the end of the next chapter"
        }
    }

    // MARK: - Internals

    private func begin() {
        isFading = false
        player.setVolume(1)
        lastTick = Date()
        ticker?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
        updateShakeDetection()
    }

    private func stopTimer() {
        ticker?.invalidate()
        ticker = nil
        shakeDetector.stop()
        mode = .off
        remaining = 0
        isFading = false
    }

    private func tick() {
        let now = Date()
        let delta = now.timeIntervalSince(lastTick)
        lastTick = now

        switch mode {
        case .off:
            return
        case .duration:
            if player.isPlaying { remaining = max(0, remaining - delta) }
        case .endOfChapter:
            remaining = max(0, (chapterEndTarget - player.livePosition) / Double(player.rate))
        }

        updateShakeDetection()

        let fadeEnabled = UserDefaults.standard.bool(forKey: "sleepFadeOut")
        if mode == .duration, fadeEnabled, player.isPlaying, remaining < Self.fadeDuration {
            isFading = true
            player.setVolume(Float(remaining / Self.fadeDuration))
        }

        if remaining <= 0 {
            expire()
        }
    }

    private func expire() {
        player.pause()
        stopTimer()
        // Restore volume once paused so the next play isn't silent.
        player.setVolume(1)
    }

    /// Only listen for shakes while audio is playing — saves battery, and a paused app
    /// is suspended by iOS in the background anyway.
    private func updateShakeDetection() {
        let shouldRun = mode != .off
            && player.isPlaying
            && UserDefaults.standard.bool(forKey: "shakeToExtend")
        if shouldRun && !shakeDetector.isRunning {
            shakeDetector.start()
        } else if !shouldRun && shakeDetector.isRunning {
            shakeDetector.stop()
        }
    }

    private func handleShake() {
        guard isActive, player.isPlaying else { return }
        extend()
    }

    private func confirmWithHaptic() {
        guard UserDefaults.standard.bool(forKey: "shakeVibrate") else { return }
        if UIApplication.shared.applicationState == .active {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            // Haptic generators don't fire in the background; a short vibration does.
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }
}
