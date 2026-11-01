import SwiftUI

struct RootView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerEngine.self) private var player
    @Environment(SleepTimer.self) private var sleepTimer
    @State private var showPlayer = false

    var body: some View {
        NavigationStack {
            LibraryView(showPlayer: $showPlayer)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if player.book != nil {
                MiniPlayerView { showPlayer = true }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: player.bookID)
        .sheet(isPresented: $showPlayer) {
            PlayerView()
                .environment(library)
                .environment(player)
                .environment(sleepTimer)
                .presentationDragIndicator(.visible)
        }
    }
}
