import SwiftUI

@main
struct AudiobooksApp: App {
    @State private var library: LibraryStore
    @State private var player: PlayerEngine
    @State private var sleepTimer: SleepTimer
    @Environment(\.scenePhase) private var scenePhase

    init() {
        UserDefaults.standard.register(defaults: [
            "skipBack": 15,
            "skipForward": 30,
            "smartRewind": true,
            "shakeToExtend": true,
            "shakeVibrate": true,
            "sleepFadeOut": true,
            "lastSleepDuration": 15.0 * 60,
        ])
        let library = LibraryStore()
        let player = PlayerEngine(library: library)
        _library = State(initialValue: library)
        _player = State(initialValue: player)
        _sleepTimer = State(initialValue: SleepTimer(player: player))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(library)
                .environment(player)
                .environment(sleepTimer)
                .onOpenURL { url in
                    Task { await library.importItems([url]) }
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        library.refresh()
                    case .background, .inactive:
                        player.persistPosition()
                    @unknown default:
                        break
                    }
                }
        }
    }
}
