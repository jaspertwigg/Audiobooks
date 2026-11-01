import CryptoKit
import Foundation
import Observation
import UIKit

/// Owns the audiobook files (stored in the app's Documents folder, which is also visible
/// in the Files app) and the saved state for each book (position, bookmarks, metadata).
@MainActor
@Observable
final class LibraryStore {
    private(set) var books: [Book] = []
    private(set) var isImporting = false
    var importError: String?

    @ObservationIgnored let documentsURL: URL
    @ObservationIgnored private let artworkURL: URL
    @ObservationIgnored private let storeURL: URL
    @ObservationIgnored private let imageCache = NSCache<NSString, UIImage>()
    @ObservationIgnored private var loadingIDs = Set<String>()

    static let audioExtensions: Set<String> = [
        "mp3", "m4a", "m4b", "aac", "mp4", "wav", "aif", "aiff", "aifc", "caf", "flac", "alac",
    ]

    init() {
        let fm = FileManager.default
        documentsURL = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let supportURL = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        artworkURL = supportURL.appendingPathComponent("Artwork", isDirectory: true)
        storeURL = supportURL.appendingPathComponent("library.json")
        try? fm.createDirectory(at: artworkURL, withIntermediateDirectories: true)
        loadFromDisk()
        refresh()
    }

    // MARK: - Lookup

    func book(withID id: String) -> Book? {
        books.first { $0.id == id }
    }

    func url(for book: Book, track index: Int) -> URL {
        let root = documentsURL.appendingPathComponent(book.id)
        guard book.isFolder, book.tracks.indices.contains(index) else { return root }
        return root.appendingPathComponent(book.tracks[index].path)
    }

    func artwork(for book: Book) -> UIImage? {
        guard let name = book.artworkFile else { return nil }
        if let cached = imageCache.object(forKey: name as NSString) { return cached }
        guard let image = UIImage(contentsOfFile: artworkURL.appendingPathComponent(name).path) else { return nil }
        imageCache.setObject(image, forKey: name as NSString)
        return image
    }

    // MARK: - Mutation

    func update(_ id: String, _ change: (inout Book) -> Void) {
        guard let index = books.firstIndex(where: { $0.id == id }) else { return }
        change(&books[index])
        save()
    }

    func delete(_ book: Book) {
        let fm = FileManager.default
        try? fm.removeItem(at: documentsURL.appendingPathComponent(book.id))
        if let art = book.artworkFile {
            try? fm.removeItem(at: artworkURL.appendingPathComponent(art))
            imageCache.removeObject(forKey: art as NSString)
        }
        books.removeAll { $0.id == book.id }
        save()
    }

    // MARK: - Importing

    /// Copies files or folders (from the document picker or "Open in…") into the library.
    /// A folder becomes one multi-file book; each loose file becomes its own book.
    func importItems(_ urls: [URL]) async {
        isImporting = true
        defer { isImporting = false }
        var failed: [String] = []
        let documents = documentsURL

        for url in urls {
            let accessing = url.startAccessingSecurityScopedResource()
            do {
                try await Task.detached(priority: .userInitiated) {
                    try Self.copyIntoLibrary(url, documents: documents)
                }.value
            } catch {
                failed.append(url.lastPathComponent)
            }
            if accessing { url.stopAccessingSecurityScopedResource() }
        }

        refresh()
        if !failed.isEmpty {
            importError = "Couldn't import: " + failed.joined(separator: ", ")
        }
    }

    nonisolated private static func copyIntoLibrary(_ source: URL, documents: URL) throws {
        let fm = FileManager.default
        let sourcePath = source.standardizedFileURL.resolvingSymlinksInPath().path
        let documentsPath = documents.standardizedFileURL.resolvingSymlinksInPath().path

        // Already in the library (e.g. opened in place from our own folder).
        if (sourcePath as NSString).deletingLastPathComponent == documentsPath { return }

        let isInbox = sourcePath.hasPrefix(documentsPath + "/Inbox/")
        let destination = uniqueDestination(for: source.lastPathComponent, in: documents)

        var coordinatorError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinatorError) { readableURL in
            do {
                if isInbox {
                    try fm.moveItem(at: readableURL, to: destination)
                } else {
                    try fm.copyItem(at: readableURL, to: destination)
                }
            } catch {
                copyError = error
            }
        }
        if let coordinatorError { throw coordinatorError }
        if let copyError { throw copyError }
    }

    nonisolated private static func uniqueDestination(for name: String, in folder: URL) -> URL {
        let fm = FileManager.default
        var candidate = folder.appendingPathComponent(name)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var counter = 2
        while fm.fileExists(atPath: candidate.path) {
            let newName = ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)"
            candidate = folder.appendingPathComponent(newName)
            counter += 1
        }
        return candidate
    }

    // MARK: - Scanning

    private struct ScannedItem {
        let id: String
        let isFolder: Bool
        let trackPaths: [String]
    }

    /// Re-scans the Documents folder so books added through the Files app appear,
    /// and books deleted there disappear.
    func refresh() {
        let scanned = scanDocuments()
        var updated: [Book] = []
        for item in scanned {
            if var existing = books.first(where: { $0.id == item.id }) {
                if existing.tracks.map(\.path) != item.trackPaths {
                    existing.tracks = item.trackPaths.map { Track(path: $0, duration: 0) }
                    existing.metadataLoaded = false
                }
                updated.append(existing)
            } else {
                let title = item.isFolder ? item.id : (item.id as NSString).deletingPathExtension
                updated.append(Book(
                    id: item.id,
                    isFolder: item.isFolder,
                    title: title,
                    tracks: item.trackPaths.map { Track(path: $0, duration: 0) }
                ))
            }
        }
        books = updated
        save()
        for book in books where !book.metadataLoaded {
            loadMetadata(for: book)
        }
    }

    private func scanDocuments() -> [ScannedItem] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: documentsURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var items: [ScannedItem] = []
        for url in entries {
            let name = url.lastPathComponent
            if name == "Inbox" { continue }
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDirectory {
                let tracks = audioFiles(inFolder: url)
                if !tracks.isEmpty {
                    items.append(ScannedItem(id: name, isFolder: true, trackPaths: tracks))
                }
            } else if Self.audioExtensions.contains(url.pathExtension.lowercased()) {
                items.append(ScannedItem(id: name, isFolder: false, trackPaths: [name]))
            }
        }
        return items
    }

    /// All audio files inside a folder (including sub-folders like "CD 1"), in natural order.
    private func audioFiles(inFolder folder: URL) -> [String] {
        guard let enumerator = FileManager.default.enumerator(
            at: folder,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return [] }

        let base = folder.standardizedFileURL.path
        var paths: [String] = []
        for case let url as URL in enumerator where Self.audioExtensions.contains(url.pathExtension.lowercased()) {
            let full = url.standardizedFileURL.path
            let relative = full.hasPrefix(base + "/") ? String(full.dropFirst(base.count + 1)) : url.lastPathComponent
            paths.append(relative)
        }
        return paths.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    private func loadMetadata(for book: Book) {
        guard !loadingIDs.contains(book.id) else { return }
        loadingIDs.insert(book.id)
        let trackURLs = book.tracks.indices.map { url(for: book, track: $0) }
        let folderURL = book.isFolder ? documentsURL.appendingPathComponent(book.id) : nil
        let artworkFolder = artworkURL

        Task {
            let metadata = await MetadataLoader.load(trackURLs: trackURLs, folderURL: folderURL)
            loadingIDs.remove(book.id)
            guard let index = books.firstIndex(where: { $0.id == book.id }) else { return }

            var updated = books[index]
            if let title = metadata.title { updated.title = title }
            updated.author = metadata.author
            updated.tracks = zip(updated.tracks, metadata.durations).map { Track(path: $0.path, duration: $1) }
            updated.chapters = metadata.chapters
            if let artwork = metadata.artwork {
                let name = Self.artworkName(for: book.id)
                try? artwork.write(to: artworkFolder.appendingPathComponent(name), options: .atomic)
                imageCache.removeObject(forKey: name as NSString)
                updated.artworkFile = name
            }
            updated.metadataLoaded = true
            books[index] = updated
            save()
        }
    }

    private static func artworkName(for id: String) -> String {
        let digest = SHA256.hash(data: Data(id.utf8))
        return digest.map { String(format: "%02x", $0) }.joined() + ".jpg"
    }

    // MARK: - Persistence

    private func loadFromDisk() {
        guard let data = try? Data(contentsOf: storeURL),
              let decoded = try? JSONDecoder().decode([Book].self, from: data) else { return }
        books = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(books) else { return }
        try? data.write(to: storeURL, options: .atomic)
    }
}
