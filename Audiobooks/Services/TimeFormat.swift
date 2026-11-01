import Foundation

enum TimeFormat {
    /// "1:02:03" or "2:03"
    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "--:--" }
        let total = Int(max(0, seconds).rounded(.down))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "3h 12m", "12m", "45s"
    static func short(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "–" }
        let total = Int(max(0, seconds))
        let h = total / 3600, m = (total % 3600) / 60
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        if m > 0 { return "\(m)m" }
        return "\(total)s"
    }

    /// "15 min", "1 hr", "1 hr 30 min"
    static func minutes(_ seconds: Double) -> String {
        let totalMinutes = Int((max(0, seconds) / 60).rounded())
        let h = totalMinutes / 60, m = totalMinutes % 60
        if h == 0 { return "\(m) min" }
        return m == 0 ? "\(h) hr" : "\(h) hr \(m) min"
    }

    static func rate(_ rate: Float) -> String {
        let formatted = String(format: "%.2f", rate)
            .replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
        return formatted + "×"
    }
}
