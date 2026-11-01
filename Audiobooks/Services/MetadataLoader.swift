import AVFoundation
import UIKit

struct LoadedMetadata: Sendable {
    var title: String?
    var author: String?
    var durations: [Double] = []
    var chapters: [Chapter] = []
    /// JPEG thumbnail of the cover art, if any was found.
    var artwork: Data?
}

/// Reads durations, titles, authors, chapter markers and cover art from audio files.
/// Runs off the main actor.
enum MetadataLoader {
    static func load(trackURLs: [URL], folderURL: URL?) async -> LoadedMetadata {
        var result = LoadedMetadata()
        var offset = 0.0
        var artworkData: Data? = folderURL.flatMap(folderImage(in:))
        var firstTitle: String?
        var firstAlbum: String?

        for (index, url) in trackURLs.enumerated() {
            let asset = AVURLAsset(url: url)
            var duration = 0.0
            var metadata: [AVMetadataItem] = []
            if let loaded = try? await asset.load(.duration, .commonMetadata) {
                duration = loaded.0.seconds.isFinite ? loaded.0.seconds : 0
                metadata = loaded.1
            }

            let trackTitle = await firstString(in: metadata, keys: [.commonKeyTitle])

            if index == 0 {
                firstTitle = trackTitle
                firstAlbum = await firstString(in: metadata, keys: [.commonKeyAlbumName])
                result.author = await firstString(in: metadata, keys: [.commonKeyArtist, .commonKeyAuthor, .commonKeyCreator])
            }
            if artworkData == nil,
               let item = metadata.first(where: { $0.commonKey == .commonKeyArtwork }) {
                artworkData = try? await item.load(.dataValue)
            }

            // Embedded chapter markers (typical for .m4b files).
            var trackChapters = await embeddedChapters(of: asset, offset: offset, trackDuration: duration)

            // Multi-file books without embedded chapters: each file is a chapter.
            if trackChapters.isEmpty && trackURLs.count > 1 {
                let name = trackTitle ?? url.deletingPathExtension().lastPathComponent
                trackChapters = [Chapter(title: name, start: offset, duration: duration)]
            }

            result.chapters += trackChapters
            result.durations.append(duration)
            offset += duration
        }

        result.title = trackURLs.count > 1 ? firstAlbum : (firstTitle ?? firstAlbum)
        result.artwork = artworkData.flatMap(thumbnail(from:))
        return result
    }

    private static func embeddedChapters(of asset: AVURLAsset, offset: Double, trackDuration: Double) async -> [Chapter] {
        var groups = (try? await asset.loadChapterMetadataGroups(bestMatchingPreferredLanguages: Locale.preferredLanguages)) ?? []
        if groups.isEmpty,
           let locales = try? await asset.load(.availableChapterLocales),
           let locale = locales.first {
            groups = (try? await asset.loadChapterMetadataGroups(withTitleLocale: locale, containingItemsWithCommonKeys: [])) ?? []
        }
        guard !groups.isEmpty else { return [] }

        var starts: [(title: String, start: Double)] = []
        for (index, group) in groups.enumerated() {
            let start = group.timeRange.start.seconds
            let title = await firstString(in: group.items, keys: [.commonKeyTitle]) ?? "Chapter \(index + 1)"
            starts.append((title, start.isFinite ? start : 0))
        }
        starts.sort { $0.start < $1.start }

        return starts.enumerated().map { index, item in
            let end = index + 1 < starts.count ? starts[index + 1].start : trackDuration
            return Chapter(title: item.title, start: offset + item.start, duration: max(0, end - item.start))
        }
    }

    private static func firstString(in items: [AVMetadataItem], keys: [AVMetadataKey]) async -> String? {
        for key in keys {
            for item in items where item.commonKey == key {
                if let value = try? await item.load(.stringValue) {
                    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { return trimmed }
                }
            }
        }
        return nil
    }

    /// Looks for cover.jpg / folder.png / any image in a book folder.
    private static func folderImage(in folder: URL) -> Data? {
        let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "heic"]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return nil }
        let images = files.filter { imageExtensions.contains($0.pathExtension.lowercased()) }
        let preferred = images.first { name in
            let lower = name.deletingPathExtension().lastPathComponent.lowercased()
            return lower.contains("cover") || lower.contains("folder") || lower.contains("front")
        }
        guard let url = preferred ?? images.first else { return nil }
        return try? Data(contentsOf: url)
    }

    private static func thumbnail(from data: Data) -> Data? {
        guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
        let maxSide: CGFloat = 800
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let resized = image.preparingThumbnail(of: size) ?? image
        return resized.jpegData(compressionQuality: 0.85)
    }
}
