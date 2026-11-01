import SwiftUI

/// Square cover art, with a generated placeholder when the book has none.
struct ArtworkView: View {
    @Environment(LibraryStore.self) private var library
    let book: Book
    var cornerRadius: CGFloat = 8

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image = library.artwork(for: book) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    placeholder
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(.primary.opacity(0.08), lineWidth: 0.5)
            }
            .accessibilityHidden(true)
    }

    private var placeholder: some View {
        // Stable per book (String.hashValue changes every launch).
        let seed = book.id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        let hue = Double(seed % 360) / 360
        return LinearGradient(
            colors: [Color(hue: hue, saturation: 0.45, brightness: 0.75),
                     Color(hue: hue, saturation: 0.6, brightness: 0.45)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay {
            GeometryReader { proxy in
                Image(systemName: "book.closed.fill")
                    .font(.system(size: proxy.size.width * 0.35))
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}
