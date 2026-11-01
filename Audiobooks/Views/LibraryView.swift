import SwiftUI
import UniformTypeIdentifiers

enum LibrarySort: String, CaseIterable, Identifiable {
    case recent, title, author, added
    var id: String { rawValue }
    var label: String {
        switch self {
        case .recent: return "Recently Played"
        case .title: return "Title"
        case .author: return "Author"
        case .added: return "Date Added"
        }
    }
}

struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerEngine.self) private var player
    @Binding var showPlayer: Bool

    @AppStorage("librarySort") private var sort: LibrarySort = .recent
    @State private var showImporter = false
    @State private var showSettings = false
    @State private var search = ""
    @State private var bookToDelete: Book?

    private static let importTypes: [UTType] = {
        var types: [UTType] = [.audio, .folder]
        if let m4b = UTType(filenameExtension: "m4b") { types.append(m4b) }
        return types
    }()

    var body: some View {
        Group {
            if library.books.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .navigationTitle("Library")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if library.isImporting {
                    ProgressView()
                }
                Menu {
                    Picker("Sort By", selection: $sort) {
                        ForEach(LibrarySort.allCases) { Text($0.label).tag($0) }
                    }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
                Button { showImporter = true } label: {
                    Label("Add Audiobooks", systemImage: "plus")
                }
            }
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: Self.importTypes,
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                Task { await library.importItems(urls) }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .alert("Import Problem", isPresented: Binding(
            get: { library.importError != nil },
            set: { if !$0 { library.importError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(library.importError ?? "")
        }
        .confirmationDialog(
            "Delete “\(bookToDelete?.title ?? "")”?",
            isPresented: Binding(get: { bookToDelete != nil }, set: { if !$0 { bookToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let book = bookToDelete { delete(book) }
            }
        } message: {
            Text("The audio files will be removed from this iPhone.")
        }
    }

    private var list: some View {
        List {
            ForEach(visibleBooks) { book in
                Button {
                    guard book.metadataLoaded else { return }
                    player.load(book)
                    showPlayer = true
                } label: {
                    BookRow(book: book, isCurrent: player.bookID == book.id, isPlaying: player.isPlaying)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { bookToDelete = book } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .swipeActions(edge: .leading) {
                    finishedButton(for: book)
                }
                .contextMenu {
                    finishedButton(for: book)
                    Button {
                        library.update(book.id) { $0.position = 0; $0.isFinished = false }
                        if player.bookID == book.id { player.seek(to: 0) }
                    } label: {
                        Label("Start Over", systemImage: "backward.end")
                    }
                    Divider()
                    Button(role: .destructive) { bookToDelete = book } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $search, prompt: "Title or author")
        .refreshable { library.refresh() }
    }

    @ViewBuilder
    private func finishedButton(for book: Book) -> some View {
        Button {
            library.update(book.id) { $0.isFinished.toggle() }
        } label: {
            if book.isFinished {
                Label("Mark as Unfinished", systemImage: "circle")
            } else {
                Label("Mark as Finished", systemImage: "checkmark.circle")
            }
        }
        .tint(.green)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Audiobooks Yet", systemImage: "headphones")
        } description: {
            Text("Add audio files or a folder of files (MP3, M4A, M4B, AAC, WAV, FLAC). A folder becomes one book.\n\nYou can also copy files into **On My iPhone › Audiobooks** in the Files app.")
        } actions: {
            Button {
                showImporter = true
            } label: {
                Label("Add Audiobooks", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var visibleBooks: [Book] {
        var books = library.books
        let query = search.trimmingCharacters(in: .whitespaces)
        if !query.isEmpty {
            books = books.filter {
                $0.title.localizedCaseInsensitiveContains(query)
                    || ($0.author ?? "").localizedCaseInsensitiveContains(query)
            }
        }
        switch sort {
        case .recent:
            books.sort { ($0.lastPlayed ?? $0.dateAdded) > ($1.lastPlayed ?? $1.dateAdded) }
        case .title:
            books.sort { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        case .author:
            books.sort {
                let a = $0.author ?? "~", b = $1.author ?? "~"
                return a == b
                    ? $0.title.localizedStandardCompare($1.title) == .orderedAscending
                    : a.localizedStandardCompare(b) == .orderedAscending
            }
        case .added:
            books.sort { $0.dateAdded > $1.dateAdded }
        }
        return books
    }

    private func delete(_ book: Book) {
        if player.bookID == book.id { player.unload() }
        library.delete(book)
    }
}

struct BookRow: View {
    let book: Book
    let isCurrent: Bool
    let isPlaying: Bool

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(book: book, cornerRadius: 6)
                .frame(width: 64, height: 64)

            VStack(alignment: .leading, spacing: 4) {
                Text(book.title)
                    .font(.headline)
                    .lineLimit(2)
                if let author = book.author {
                    Text(author)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if book.metadataLoaded {
                    HStack(spacing: 8) {
                        ProgressView(value: book.progress)
                            .tint(book.isFinished ? .green : .accentColor)
                            .frame(maxWidth: 120)
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                } else {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Reading file…").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
            if isCurrent {
                Image(systemName: "waveform")
                    .foregroundStyle(.tint)
                    .symbolEffect(.variableColor.iterative, isActive: isPlaying)
                    .accessibilityLabel(isPlaying ? "Playing" : "Current book")
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private var status: String {
        if book.isFinished { return "Finished" }
        if book.position < 1 { return "\(TimeFormat.short(book.duration)) · New" }
        return "\(TimeFormat.short(book.remaining)) left"
    }
}
