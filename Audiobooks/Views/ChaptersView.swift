import SwiftUI

struct ChaptersView: View {
    @Environment(PlayerEngine.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(\.dismiss) private var dismiss

    private enum Tab: Hashable { case chapters, bookmarks }
    @State private var tab: Tab = .chapters

    var body: some View {
        NavigationStack {
            Group {
                if tab == .chapters && !player.chapters.isEmpty {
                    chapterList
                } else {
                    bookmarkList
                }
            }
            .navigationTitle(player.book?.title ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    if !player.chapters.isEmpty {
                        Picker("Show", selection: $tab) {
                            Text("Chapters").tag(Tab.chapters)
                            Text("Bookmarks").tag(Tab.bookmarks)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 240)
                    } else {
                        Text("Bookmarks").font(.headline)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var chapterList: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(Array(player.chapters.enumerated()), id: \.offset) { index, chapter in
                    Button {
                        player.seek(to: chapter.start)
                        if !player.isPlaying { player.play() }
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            ZStack {
                                if index == player.chapterIndex {
                                    Image(systemName: "speaker.wave.2.fill")
                                        .foregroundStyle(.tint)
                                        .symbolEffect(.variableColor.iterative, isActive: player.isPlaying)
                                } else {
                                    Text("\(index + 1)")
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                }
                            }
                            .frame(width: 28)
                            .font(.subheadline)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(chapter.title)
                                    .fontWeight(index == player.chapterIndex ? .semibold : .regular)
                                    .foregroundStyle(chapter.end <= player.position && index != player.chapterIndex ? .secondary : .primary)
                                Text(TimeFormat.clock(chapter.start))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(TimeFormat.short(chapter.duration))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .id(index)
                }
            }
            .listStyle(.plain)
            .onAppear {
                if let index = player.chapterIndex {
                    proxy.scrollTo(index, anchor: .center)
                }
            }
        }
    }

    @ViewBuilder
    private var bookmarkList: some View {
        let bookmarks = (player.book?.bookmarks ?? []).sorted { $0.position < $1.position }
        if bookmarks.isEmpty {
            ContentUnavailableView(
                "No Bookmarks",
                systemImage: "bookmark",
                description: Text("Tap Bookmark in the player to save your current spot.")
            )
        } else {
            List {
                ForEach(bookmarks) { bookmark in
                    Button {
                        player.seek(to: bookmark.position)
                        if !player.isPlaying { player.play() }
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bookmark.note)
                            HStack {
                                Text(TimeFormat.clock(bookmark.position)).monospacedDigit()
                                Text("·")
                                Text(bookmark.created, style: .date)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) {
                            if let id = player.bookID {
                                library.update(id) { book in book.bookmarks.removeAll { $0.id == bookmark.id } }
                            }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            .listStyle(.plain)
        }
    }
}
