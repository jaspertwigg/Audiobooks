import CoreMotion
import Foundation

/// Detects a deliberate shake using Core Motion.
///
/// Unlike UIKit's shake gesture (which only works while the app is on screen), this keeps working
/// while the screen is locked, because the app stays running in the background while audio plays.
/// A "shake" is several strong back-and-forth jolts within a short window, so rolling over in bed
/// or putting the phone down doesn't trigger it.
@MainActor
final class ShakeDetector {
    var onShake: (() -> Void)?
    private(set) var isRunning = false

    private let manager = CMMotionManager()
    private var joltTimes: [TimeInterval] = []
    private var lastJoltSign = 0
    private var lastJoltAxis = -1
    private var cooldownUntil: TimeInterval = 0

    /// User acceleration (in g, gravity removed) a jolt must exceed.
    private let threshold = 1.3
    /// Jolts needed within `window` seconds to count as a shake.
    private let requiredJolts = 3
    private let window: TimeInterval = 1.2

    func start() {
        guard !isRunning else { return }
        isRunning = true
        joltTimes.removeAll()

        if manager.isDeviceMotionAvailable {
            manager.deviceMotionUpdateInterval = 1.0 / 50.0
            manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
                guard let motion else { return }
                let a = motion.userAcceleration
                let timestamp = motion.timestamp
                MainActor.assumeIsolated { self?.process(x: a.x, y: a.y, z: a.z, at: timestamp) }
            }
        } else if manager.isAccelerometerAvailable {
            manager.accelerometerUpdateInterval = 1.0 / 50.0
            manager.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
                guard let data else { return }
                let a = data.acceleration
                let timestamp = data.timestamp
                // Raw accelerometer includes ~1g of gravity; the threshold check is per-axis so this is close enough.
                MainActor.assumeIsolated { self?.process(x: a.x, y: a.y, z: a.z, at: timestamp, gravityIncluded: true) }
            }
        }
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        manager.stopDeviceMotionUpdates()
        manager.stopAccelerometerUpdates()
        joltTimes.removeAll()
    }

    private func process(x: Double, y: Double, z: Double, at time: TimeInterval, gravityIncluded: Bool = false) {
        guard time >= cooldownUntil else { return }
        let components = [x, y, z]
        let magnitudes = components.map(abs)
        guard let peak = magnitudes.max(), let axis = magnitudes.firstIndex(of: peak) else { return }
        let effectiveThreshold = gravityIncluded ? threshold + 1 : threshold
        guard peak > effectiveThreshold else { return }

        let sign = components[axis] >= 0 ? 1 : -1
        if let last = joltTimes.last, time - last > window {
            joltTimes.removeAll()
            lastJoltAxis = -1
            lastJoltSign = 0
        }
        // Count a new jolt only when the direction reverses (a shake goes back and forth).
        if axis == lastJoltAxis && sign == lastJoltSign { return }
        lastJoltAxis = axis
        lastJoltSign = sign

        joltTimes.append(time)
        joltTimes.removeAll { time - $0 > window }

        if joltTimes.count >= requiredJolts {
            joltTimes.removeAll()
            lastJoltAxis = -1
            lastJoltSign = 0
            cooldownUntil = time + 1.5
            onShake?()
        }
    }
}
