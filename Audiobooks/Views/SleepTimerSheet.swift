import SwiftUI

struct SleepTimerSheet: View {
    @Environment(SleepTimer.self) private var timer
    @Environment(PlayerEngine.self) private var player
    @Environment(\.dismiss) private var dismiss
    @AppStorage("shakeToExtend") private var shakeToExtend = true
    @State private var customMinutes = 20

    private let presets = [5, 10, 15, 20, 30, 45, 60, 90]

    var body: some View {
        NavigationStack {
            List {
                if timer.isActive {
                    activeSection
                }

                Section {
                    ForEach(presets, id: \.self) { minutes in
                        Button {
                            start(minutes: minutes)
                        } label: {
                            HStack {
                                Text(TimeFormat.minutes(Double(minutes) * 60))
                                Spacer()
                                if timer.mode == .duration && Int(timer.originalDuration / 60) == minutes {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                    Button {
                        timer.startEndOfChapter()
                        startPlaybackIfNeeded()
                        dismiss()
                    } label: {
                        HStack {
                            Text("End of Chapter")
                            Spacer()
                            if timer.mode == .endOfChapter {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                    }
                    .disabled(player.currentChapter == nil)
                } header: {
                    Text("Stop playing after")
                }

                Section {
                    Stepper(value: $customMinutes, in: 1...480) {
                        Text(TimeFormat.minutes(Double(customMinutes) * 60))
                            .monospacedDigit()
                    }
                    Button("Start \(TimeFormat.minutes(Double(customMinutes) * 60)) Timer") {
                        start(minutes: customMinutes)
                    }
                } header: {
                    Text("Custom")
                }

                Section {
                    Toggle("Shake to Extend", isOn: $shakeToExtend)
                } footer: {
                    Text("While the timer is running, shake your iPhone to add the timer's original length again — even with the screen locked. The volume fades out over the last \(Int(SleepTimer.fadeDuration)) seconds; shake during the fade to keep listening. The countdown pauses whenever playback is paused.")
                }
            }
            .navigationTitle("Sleep Timer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var activeSection: some View {
        Section {
            VStack(spacing: 6) {
                Text(TimeFormat.clock(timer.remaining))
                    .font(.system(size: 52, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(countsDown: true))
                    .animation(.default, value: Int(timer.remaining))
                Text(timer.mode == .endOfChapter ? "until the end of this chapter" : "remaining")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if shakeToExtend {
                    Label(timer.shakeHint, systemImage: "iphone.radiowaves.left.and.right")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.tint)
                        .padding(.top, 4)
                }
                if !player.isPlaying {
                    Text("Paused — the timer resumes when playback does.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)

            Button {
                timer.extend()
            } label: {
                Label(
                    timer.mode == .duration
                        ? "Add \(TimeFormat.minutes(timer.originalDuration))"
                        : "Extend to Next Chapter",
                    systemImage: "plus.circle"
                )
            }
            Button(role: .destructive) {
                timer.cancel()
            } label: {
                Label("Turn Off Timer", systemImage: "xmark.circle")
            }
        }
    }

    private func start(minutes: Int) {
        timer.start(duration: Double(minutes) * 60)
        startPlaybackIfNeeded()
        dismiss()
    }

    private func startPlaybackIfNeeded() {
        if !player.isPlaying { player.play() }
    }
}
