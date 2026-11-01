import SwiftUI

struct PlayerView: View {
    @Environment(PlayerEngine.self) private var player
    @Environment(SleepTimer.self) private var sleepTimer
    @Environment(\.dismiss) private var dismiss
    @AppStorage("skipBack") private var skipBack = 15
    @AppStorage("skipForward") private var skipForward = 30

    @State private var isScrubbing = false
    @State private var scrubValue = 0.0
    @State private var showSleepTimer = false
    @State private var showChapters = false
    @State private var toast: String?
    @State private var toastTask: Task<Void, Never>?

    var body: some View {
        Group {
            if let book = player.book {
                content(book)
            } else {
                ContentUnavailableView("Nothing Playing", systemImage: "headphones")
            }
        }
        .overlay(alignment: .top) {
            if let toast {
                Text(toast)
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.thickMaterial, in: Capsule())
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: toast)
        .sheet(isPresented: $showSleepTimer) {
            SleepTimerSheet()
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showChapters) {
            ChaptersView()
        }
        .onChange(of: sleepTimer.extensionCount) { _, _ in
            if sleepTimer.mode == .duration {
                showToast("Sleep timer +\(TimeFormat.minutes(sleepTimer.originalDuration))")
            } else {
                showToast("Sleep timer extended to next chapter")
            }
        }
    }

    private func content(_ book: Book) -> some View {
        VStack(spacing: 0) {
            Spacer(minLength: 16)

            ArtworkView(book: book, cornerRadius: 14)
                .frame(maxWidth: 340)
                .shadow(color: .black.opacity(0.25), radius: 18, y: 8)
                .scaleEffect(player.isPlaying ? 1 : 0.92)
                .animation(.spring(duration: 0.4), value: player.isPlaying)
                .padding(.horizontal, 8)
                .layoutPriority(-1)

            Spacer(minLength: 16)

            VStack(spacing: 4) {
                Text(book.title)
                    .font(.title3.weight(.bold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                if let author = book.author {
                    Text(author)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let chapter = player.currentChapter {
                    Button {
                        showChapters = true
                    } label: {
                        HStack(spacing: 4) {
                            Text(chapter.title).lineLimit(1)
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                        }
                        .font(.subheadline.weight(.medium))
                    }
                    .padding(.top, 2)
                }
            }

            scrubber(book)
                .padding(.top, 20)

            transport
                .padding(.top, 12)

            bottomBar
                .padding(.top, 24)
                .padding(.bottom, 8)
        }
        .padding(.horizontal, 24)
    }

    // MARK: - Scrubber

    /// Scrubs within the current chapter when there are chapters, otherwise the whole book.
    private func scrubRange(_ book: Book) -> ClosedRange<Double> {
        if let chapter = player.currentChapter, chapter.duration > 1 {
            return chapter.start...chapter.end
        }
        return 0...max(book.duration, 1)
    }

    private func scrubber(_ book: Book) -> some View {
        let range = scrubRange(book)
        let current = isScrubbing ? scrubValue : min(max(player.position, range.lowerBound), range.upperBound)
        let binding = Binding<Double>(
            get: { current },
            set: { scrubValue = $0 }
        )
        let rate = Double(player.rate)

        return VStack(spacing: 6) {
            Slider(value: binding, in: range) { editing in
                if editing {
                    scrubValue = current
                    isScrubbing = true
                } else {
                    player.seek(to: scrubValue)
                    isScrubbing = false
                }
            }
            .accessibilityLabel(player.currentChapter == nil ? "Position" : "Position in chapter")
            .accessibilityValue(TimeFormat.clock(current - range.lowerBound))

            HStack {
                Text(TimeFormat.clock(current - range.lowerBound))
                Spacer()
                Text("-" + TimeFormat.clock(range.upperBound - current))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)

            Text(bookRemainingText(book, rate: rate))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func bookRemainingText(_ book: Book, rate: Double) -> String {
        let left = max(book.duration - player.position, 0) / max(rate, 0.1)
        var text = "\(TimeFormat.short(left)) left in book"
        if rate != 1 { text += " at \(TimeFormat.rate(player.rate))" }
        return text
    }

    // MARK: - Transport

    private var transport: some View {
        HStack {
            Button { player.previousChapter() } label: {
                Image(systemName: "backward.end.fill").font(.title2)
            }
            .disabled(player.chapters.isEmpty)
            .accessibilityLabel("Previous chapter")

            Spacer()

            Button { player.skipBackward() } label: {
                Image(systemName: "gobackward.\(skipBack)").font(.system(size: 34))
            }
            .accessibilityLabel("Back \(skipBack) seconds")

            Spacer()

            Button { player.togglePlayPause() } label: {
                Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 76))
                    .contentTransition(.symbolEffect(.replace))
            }
            .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

            Spacer()

            Button { player.skipForward() } label: {
                Image(systemName: "goforward.\(skipForward)").font(.system(size: 34))
            }
            .accessibilityLabel("Forward \(skipForward) seconds")

            Spacer()

            Button { player.nextChapter() } label: {
                Image(systemName: "forward.end.fill").font(.title2)
            }
            .disabled(player.chapters.isEmpty)
            .accessibilityLabel("Next chapter")
        }
        .foregroundStyle(.primary)
        .buttonStyle(.plain)
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        @Bindable var player = player
        return HStack(alignment: .top) {
            Menu {
                Picker("Speed", selection: $player.rate) {
                    ForEach(PlayerEngine.rates, id: \.self) { rate in
                        Text(TimeFormat.rate(rate)).tag(rate)
                    }
                }
            } label: {
                barItem(icon: "gauge.with.dots.needle.67percent", title: TimeFormat.rate(player.rate))
            }
            .accessibilityLabel("Playback speed \(TimeFormat.rate(player.rate))")

            Spacer()

            Button { showSleepTimer = true } label: {
                barItem(
                    icon: sleepTimer.isActive ? "moon.zzz.fill" : "moon.zzz",
                    title: sleepTimer.isActive ? TimeFormat.clock(sleepTimer.remaining) : "Sleep",
                    highlighted: sleepTimer.isActive
                )
            }
            .accessibilityLabel(sleepTimer.isActive ? "Sleep timer, \(TimeFormat.short(sleepTimer.remaining)) left" : "Sleep timer")

            Spacer()

            Button {
                if let bookmark = player.addBookmark() {
                    showToast("Bookmark added at \(TimeFormat.clock(bookmark.position))")
                }
            } label: {
                barItem(icon: "bookmark", title: "Bookmark")
            }

            Spacer()

            Button { showChapters = true } label: {
                barItem(icon: "list.bullet", title: player.chapters.isEmpty ? "Bookmarks" : "Chapters")
            }
        }
        .buttonStyle(.plain)
    }

    private func barItem(icon: String, title: String, highlighted: Bool = false) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.title3)
                .frame(height: 24)
            Text(title)
                .font(.caption2.weight(.medium))
                .monospacedDigit()
        }
        .frame(minWidth: 64)
        .foregroundStyle(highlighted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        .contentShape(Rectangle())
    }

    private func showToast(_ message: String) {
        toastTask?.cancel()
        toast = message
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            toast = nil
        }
    }
}
