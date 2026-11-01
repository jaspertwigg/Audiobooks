import Foundation

/// One audio file that belongs to a book.
struct Track: Codable, Hashable {
    /// For folder books: path relative to the book folder. For single-file books: the file name.
    var path: String
    var duration: Double
}

/// A chapter, expressed in book-global time (seconds from the start of the whole book).
struct Chapter: Codable, Hashable {
    var title: String
    var start: Double
    var duration: Double

    var end: Double { start + duration }
}

struct Bookmark: Codable, Hashable, Identifiable {
    var id = UUID()
    var position: Double
    var note: String
    var created = Date()
}

/// An audiobook in the library. A book is either a single audio file (e.g. an .m4b)
/// or a folder of audio files that play back-to-back.
struct Book: Codable, Hashable, Identifiable {
    /// Path relative to the app's Documents folder. Stable for the lifetime of the file.
    let id: String
    var isFolder: Bool
    var title: String
    var author: String?
    var tracks: [Track]
    var chapters: [Chapter] = []
    var artworkFile: String?
    var position: Double = 0
    var isFinished = false
    var lastPlayed: Date?
    var dateAdded = Date()
    var bookmarks: [Bookmark] = []
    var metadataLoaded = false

    var duration: Double { tracks.reduce(0) { $0 + $1.duration } }

    var progress: Double {
        if isFinished { return 1 }
        guard duration > 0 else { return 0 }
        return min(max(position / duration, 0), 1)
    }

    var remaining: Double { max(duration - position, 0) }

    /// Start time (book-global) of the given track.
    func offset(ofTrack index: Int) -> Double {
        guard index > 0 else { return 0 }
        return tracks.prefix(min(index, tracks.count)).reduce(0) { $0 + $1.duration }
    }

    /// Maps a book-global time to a track index and a time within that track.
    func locate(_ time: Double) -> (track: Int, local: Double) {
        guard !tracks.isEmpty else { return (0, 0) }
        var accumulated = 0.0
        for (index, track) in tracks.enumerated() {
            if time < accumulated + track.duration || index == tracks.count - 1 {
                return (index, max(0, time - accumulated))
            }
            accumulated += track.duration
        }
        return (0, 0)
    }
}
