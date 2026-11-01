import AVFoundation
import MediaPlayer
import Observation
import UIKit

/// Plays a book (one or many files) as a single continuous timeline, remembers the position,
/// and integrates with the lock screen, Control Center, headphones and CarPlay controls.
@MainActor
@Observable
final class PlayerEngine {
    private(set) var bookID: String?
    private(set) var isPlaying = false
    /// Book-global position in seconds.
    private(set) var position: Double = 0
    private(set) var chapterIndex: Int?
    var rate: Float = 1.0 {
        didSet { applyRate() }
    }

    static let rates: [Float] = [0.75, 0.9, 1.0, 1.1, 1.2, 1.25, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0]

    @ObservationIgnored private let library: LibraryStore
    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private var trackIndex = -1
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored private var notificationTokens: [NSObjectProtocol] = []
    @ObservationIgnored private var lastSaved = Date.distantPast
    @ObservationIgnored private var pausedAt: Date?
    @ObservationIgnored private var isSeeking = false
    @ObservationIgnored private var wasPlayingBeforeInterruption = false
    @ObservationIgnored private var nowPlayingArtwork: MPMediaItemArtwork?

    init(library: LibraryStore) {
        self.library = library
        let savedRate = UserDefaults.standard.float(forKey: "playbackRate")
        rate = savedRate > 0 ? savedRate : 1.0

        player.automaticallyWaitsToMinimizeStalling = false
        player.actionAtItemEnd = .none

        configureAudioSession()
        setupRemoteCommands()
        observeNotifications()

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated { self?.handleTimeUpdate(time) }
        }

        statusObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            let playing = player.timeControlStatus != .paused
            Task { @MainActor in self?.setPlayingState(playing) }
        }

        if let lastID = UserDefaults.standard.string(forKey: "lastBookID"),
           let book = library.book(withID: lastID), book.metadataLoaded {
            load(book, autoplay: false)
        }
    }

    // MARK: - Derived state

    var book: Book? {
        guard let bookID else { return nil }
        return library.book(withID: bookID)
    }

    var duration: Double { book?.duration ?? 0 }

    var chapters: [Chapter] { book?.chapters ?? [] }

    var currentChapter: Chapter? {
        guard let chapterIndex, chapters.indices.contains(chapterIndex) else { return nil }
        return chapters[chapterIndex]
    }

    /// Position read straight from AVPlayer (more precise than the 0.5s-updated `position`).
    var livePosition: Double {
        guard let book, !isSeeking else { return position }
        let seconds = player.currentTime().seconds
        return book.offset(ofTrack: trackIndex) + (seconds.isFinite ? seconds : 0)
    }

    // MARK: - Loading

    func load(_ book: Book, autoplay: Bool = true) {
        if bookID == book.id {
            if autoplay { play() }
            return
        }
        persistPosition()
        player.pause()
        bookID = book.id
        UserDefaults.standard.set(book.id, forKey: "lastBookID")
        trackIndex = -1
        chapterIndex = nil
        pausedAt = nil
        nowPlayingArtwork = library.artwork(for: book).map(Self.makeArtwork)

        var start = book.position
        if book.isFinished {
            start = 0
            library.update(book.id) { $0.isFinished = false; $0.position = 0 }
        }
        seek(to: start)
        if autoplay { play() }
        updateNowPlaying()
    }

    func unload() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        bookID = nil
        trackIndex = -1
        position = 0
        chapterIndex = nil
        isPlaying = false
        UserDefaults.standard.removeObject(forKey: "lastBookID")
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func loadTrack(_ index: Int, of book: Book) {
        let item = AVPlayerItem(url: library.url(for: book, track: index))
        item.audioTimePitchAlgorithm = .timeDomain
        player.replaceCurrentItem(with: item)
        trackIndex = index
    }

    // MARK: - Transport

    func play() {
        guard let book else { return }
        if book.duration > 0, position >= book.duration - 1 {
            seek(to: 0)
        } else if UserDefaults.standard.bool(forKey: "smartRewind"), let pausedAt {
            // Rewind a little after a pause so you don't lose your place in a sentence.
            let pausedFor = Date().timeIntervalSince(pausedAt)
            let rewind: Double = pausedFor > 3600 ? 30 : pausedFor > 300 ? 10 : pausedFor > 30 ? 3 : 0
            if rewind > 0 { seek(to: position - rewind) }
        }
        pausedAt = nil
        try? AVAudioSession.sharedInstance().setActive(true)
        player.defaultRate = rate
        player.play()
        isPlaying = true
        library.update(book.id) { $0.lastPlayed = Date() }
        updateNowPlaying()
    }

    func pause() {
        player.pause()
        if isPlaying {
            isPlaying = false
            pausedAt = Date()
        }
        persistPosition()
        updateNowPlaying()
    }

    func togglePlayPause() {
        isPlaying ? pause() : play()
    }

    func skip(by seconds: Double) {
        seek(to: livePosition + seconds)
    }

    func skipForward() {
        skip(by: Double(UserDefaults.standard.integer(forKey: "skipForward")))
    }

    func skipBackward() {
        skip(by: -Double(UserDefaults.standard.integer(forKey: "skipBack")))
    }

    func nextChapter() {
        guard let chapterIndex, chapterIndex + 1 < chapters.count else { return }
        seek(to: chapters[chapterIndex + 1].start)
    }

    func previousChapter() {
        guard let chapterIndex, chapters.indices.contains(chapterIndex) else {
            seek(to: 0)
            return
        }
        let chapter = chapters[chapterIndex]
        if livePosition - chapter.start > 3 || chapterIndex == 0 {
            seek(to: chapter.start)
        } else {
            seek(to: chapters[chapterIndex - 1].start)
        }
    }

    func seek(to target: Double) {
        guard let book, !book.tracks.isEmpty else { return }
        let total = book.duration
        let clamped = max(0, total > 0 ? min(target, total - 0.25) : target)
        let (index, local) = book.locate(clamped)
        if index != trackIndex || player.currentItem == nil {
            loadTrack(index, of: book)
        }
        position = book.offset(ofTrack: index) + local
        isSeeking = true
        player.seek(
            to: CMTime(seconds: local, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] _ in
            Task { @MainActor in
                self?.isSeeking = false
                self?.updateNowPlaying()
            }
        }
        updateChapter()
        persistPosition()
        updateNowPlaying()
    }

    /// Used by the sleep timer to fade out.
    func setVolume(_ volume: Float) {
        player.volume = max(0, min(1, volume))
    }

    // MARK: - Bookmarks & progress

    @discardableResult
    func addBookmark() -> Bookmark? {
        guard let bookID else { return nil }
        let bookmark = Bookmark(position: livePosition, note: currentChapter?.title ?? "Bookmark")
        library.update(bookID) { $0.bookmarks.append(bookmark) }
        return bookmark
    }

    func persistPosition() {
        guard let bookID else { return }
        lastSaved = Date()
        let saved = position
        library.update(bookID) { $0.position = saved }
    }

    // MARK: - Internals

    private func applyRate() {
        UserDefaults.standard.set(rate, forKey: "playbackRate")
        player.defaultRate = rate
        if isPlaying { player.rate = rate }
        updateNowPlaying()
    }

    private func handleTimeUpdate(_ time: CMTime) {
        guard let book, !isSeeking, trackIndex >= 0 else { return }
        let local = time.seconds.isFinite ? time.seconds : 0
        position = book.offset(ofTrack: trackIndex) + local
        updateChapter()
        if Date().timeIntervalSince(lastSaved) > 5 { persistPosition() }
    }

    private func updateChapter() {
        let list = chapters
        guard !list.isEmpty else {
            chapterIndex = nil
            return
        }
        let index = list.lastIndex { $0.start <= position + 0.05 } ?? 0
        if index != chapterIndex {
            chapterIndex = index
            updateNowPlaying()
        }
    }

    private func setPlayingState(_ playing: Bool) {
        guard playing != isPlaying else { return }
        isPlaying = playing
        if !playing {
            pausedAt = Date()
            persistPosition()
        }
        updateNowPlaying()
    }

    private func trackDidEnd() {
        guard let book else { return }
        if trackIndex + 1 < book.tracks.count {
            loadTrack(trackIndex + 1, of: book)
            position = book.offset(ofTrack: trackIndex)
            player.play()
        } else {
            player.pause()
            isPlaying = false
            position = book.duration
            library.update(book.id) { $0.isFinished = true; $0.position = book.duration }
            updateNowPlaying()
        }
    }

    private func configureAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(
            .playback,
            mode: .spokenAudio,
            policy: .longFormAudio,
            options: []
        )
    }

    private func observeNotifications() {
        let center = NotificationCenter.default

        notificationTokens.append(center.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main
        ) { [weak self] note in
            let item = note.object as? AVPlayerItem
            MainActor.assumeIsolated {
                guard let self, let item, item === self.player.currentItem else { return }
                self.trackDidEnd()
            }
        })

        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let typeValue = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsValue = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            MainActor.assumeIsolated {
                guard let self, let typeValue,
                      let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
                switch type {
                case .began:
                    self.wasPlayingBeforeInterruption = self.isPlaying
                    self.setPlayingState(false)
                case .ended:
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue ?? 0)
                    if options.contains(.shouldResume) && self.wasPlayingBeforeInterruption {
                        self.play()
                    }
                    self.wasPlayingBeforeInterruption = false
                @unknown default:
                    break
                }
            }
        })

        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.configureAudioSession()
                self?.setupRemoteCommands()
            }
        })
    }

    func refreshRemoteSkipIntervals() {
        let center = MPRemoteCommandCenter.shared()
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: UserDefaults.standard.integer(forKey: "skipForward"))]
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: UserDefaults.standard.integer(forKey: "skipBack"))]
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
                        center.skipForwardCommand, center.skipBackwardCommand,
                        center.changePlaybackPositionCommand, center.nextTrackCommand,
                        center.previousTrackCommand] as [MPRemoteCommand] {
            command.removeTarget(nil)
        }

        handle(center.playCommand) { engine, _ in engine.play(); return .success }
        handle(center.pauseCommand) { engine, _ in engine.pause(); return .success }
        handle(center.togglePlayPauseCommand) { engine, _ in engine.togglePlayPause(); return .success }
        handle(center.skipForwardCommand) { engine, _ in engine.skipForward(); return .success }
        handle(center.skipBackwardCommand) { engine, _ in engine.skipBackward(); return .success }
        handle(center.changePlaybackPositionCommand) { engine, event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            engine.seek(to: event.positionTime)
            return .success
        }
        // Headphone double/triple-click: skip rather than jump chapters (the audiobook convention).
        center.nextTrackCommand.isEnabled = false
        center.previousTrackCommand.isEnabled = false
        refreshRemoteSkipIntervals()
    }

    /// MediaPlayer calls command handlers on the main thread.
    private func handle(
        _ command: MPRemoteCommand,
        _ action: @escaping @MainActor (PlayerEngine, MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus
    ) {
        command.isEnabled = true
        command.addTarget { [weak self] event in
            MainActor.assumeIsolated { () -> MPRemoteCommandHandlerStatus in
                guard let self else { return .commandFailed }
                return action(self, event)
            }
        }
    }

    private func updateNowPlaying() {
        guard let book else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        if nowPlayingArtwork == nil, let image = library.artwork(for: book) {
            nowPlayingArtwork = Self.makeArtwork(image)
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: book.title,
            MPMediaItemPropertyArtist: currentChapter?.title ?? book.author ?? "",
            MPMediaItemPropertyAlbumTitle: book.title,
            MPMediaItemPropertyPlaybackDuration: book.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? Double(rate) : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: Double(rate),
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let nowPlayingArtwork {
            info[MPMediaItemPropertyArtwork] = nowPlayingArtwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Built outside the main actor: MediaPlayer calls the image handler on a background queue.
    nonisolated private static func makeArtwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }
}
