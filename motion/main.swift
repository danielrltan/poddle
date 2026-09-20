import CoreMotion
import Foundation

// AirPods IMU -> one JSON object per line on stdout. Diagnostics on stderr.
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

final class Delegate: NSObject, CMHeadphoneMotionManagerDelegate {
    func headphoneMotionManagerDidConnect(_ m: CMHeadphoneMotionManager) {
        log("[+] headphones CONNECTED to motion service")
    }
    func headphoneMotionManagerDidDisconnect(_ m: CMHeadphoneMotionManager) {
        log("[-] headphones DISCONNECTED from motion service  <- this is what 'not worn' looks like")
    }
}

let mgr = CMHeadphoneMotionManager()
let del = Delegate()
mgr.delegate = del

func authName(_ s: CMAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined (no prompt shown yet)"
    case .restricted:    return "restricted"
    case .denied:        return "DENIED  <- System Settings > Privacy & Security > Motion & Fitness"
    case .authorized:    return "authorized"
    @unknown default:    return "unknown"
    }
}
log("auth: " + authName(CMHeadphoneMotionManager.authorizationStatus()))
log("isDeviceMotionAvailable: \(mgr.isDeviceMotionAvailable)")

guard mgr.isDeviceMotionAvailable else { log("NO-GO: device motion unavailable"); exit(1) }

let out = FileHandle.standardOutput
let nl = "\n".data(using: .utf8)!
var count = 0

mgr.startDeviceMotionUpdates(to: .main) { motion, error in
    if let error = error { log("ERR: \(error.localizedDescription)"); return }
    guard let m = motion else { return }
    count += 1
    if count == 1 { log("[OK] first sample received - motion is LIVE") }
    let q = m.attitude.quaternion, r = m.rotationRate, a = m.userAcceleration
    let obj: [String: Any] = ["t": m.timestamp,
                              "q": [q.x, q.y, q.z, q.w],
                              "r": [r.x, r.y, r.z],
                              "a": [a.x, a.y, a.z]]
    if let d = try? JSONSerialization.data(withJSONObject: obj) { out.write(d); out.write(nl) }
}

// Watchdog: turn the silent failure into an answer.
Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { _ in
    if count == 0 {
        log("... no samples after 4s | auth=" + authName(CMHeadphoneMotionManager.authorizationStatus()))
        log("    -> if auth=authorized, the buds are connected but NOT being 'worn'.")
        log("    -> turn OFF Automatic Ear Detection, or cover the optical sensor.")
    } else { log("... \(count) samples") }
}

log("waiting for samples (put a bud in your ear first to confirm the pipe works)...")
RunLoop.main.run()
