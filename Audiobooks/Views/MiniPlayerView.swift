import SwiftUI

struct MiniPlayerView: View {
    @Environment(PlayerEngine.self) private var player
    @Environment(SleepTimer.self) private var sleepTimer
    let onOpen: () -> Void

    var body: some View {
        if let book = player.book {
            VStack(spacing: 0) {
                GeometryReader { proxy in
                    Rectangle()
                        .fill(.tint)
                        .frame(width: proxy.size.width * progress(book))
                }
                .frame(height: 2)

                HStack(spacing: 12) {
                    ArtworkView(book: book, cornerRadius: 4)
                        .frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(book.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            if sleepTimer.isActive {
                                Label(TimeFormat.clock(sleepTimer.remaining), systemImage: "moon.zzz.fill")
                                    .labelStyle(.titleAndIcon)
                                    .foregroundStyle(.tint)
                                    .monospacedDigit()
                            }
                            Text(player.currentChapter?.title ?? book.author ?? "")
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .font(.caption)
                    }
                    Spacer(minLength: 0)
                    Button {
                        player.togglePlayPause()
                    } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title2)
                            .frame(width: 44, height: 44)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
                    Button {
                        player.skipForward()
                    } label: {
                        Image(systemName: "goforward.\(UserDefaults.standard.integer(forKey: "skipForward"))")
                            .font(.title3)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Skip forward")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .foregroundStyle(.primary)
            .background(.bar)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens the player")
        }
    }

    private func progress(_ book: Book) -> Double {
        guard book.duration > 0 else { return 0 }
        return min(max(player.position / book.duration, 0), 1)
    }
}
