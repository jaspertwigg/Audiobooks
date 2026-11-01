import SwiftUI

struct SettingsView: View {
    @Environment(PlayerEngine.self) private var player
    @Environment(\.dismiss) private var dismiss

    @AppStorage("skipBack") private var skipBack = 15
    @AppStorage("skipForward") private var skipForward = 30
    @AppStorage("smartRewind") private var smartRewind = true
    @AppStorage("shakeToExtend") private var shakeToExtend = true
    @AppStorage("shakeVibrate") private var shakeVibrate = true
    @AppStorage("sleepFadeOut") private var sleepFadeOut = true

    var body: some View {
        NavigationStack {
            Form {
                Section("Skip Buttons") {
                    Picker("Back", selection: $skipBack) {
                        ForEach([5, 10, 15, 30, 45, 60], id: \.self) { Text("\($0) seconds").tag($0) }
                    }
                    Picker("Forward", selection: $skipForward) {
                        ForEach([10, 15, 30, 45, 60], id: \.self) { Text("\($0) seconds").tag($0) }
                    }
                }

                Section {
                    Toggle("Smart Rewind", isOn: $smartRewind)
                } footer: {
                    Text("When you resume after a pause, rewind a few seconds (longer after longer breaks) so you don't lose the thread.")
                }

                Section {
                    Toggle("Shake to Extend", isOn: $shakeToExtend)
                    Toggle("Vibrate When Extended", isOn: $shakeVibrate)
                        .disabled(!shakeToExtend)
                    Toggle("Fade Out at End", isOn: $sleepFadeOut)
                } header: {
                    Text("Sleep Timer")
                } footer: {
                    Text("Shaking your iPhone while a sleep timer is running adds the timer's original length again.")
                }

                Section {
                    Label {
                        Text("Open the **Files** app, go to **On My iPhone › Audiobooks**, and drop in audio files or folders. From a Mac, use Finder's Files tab with your iPhone connected. Pull down on the library to refresh.")
                    } icon: {
                        Image(systemName: "folder")
                    }
                    .font(.footnote)
                } header: {
                    Text("Adding Books")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: skipBack) { _, _ in player.refreshRemoteSkipIntervals() }
            .onChange(of: skipForward) { _, _ in player.refreshRemoteSkipIntervals() }
        }
    }
}
