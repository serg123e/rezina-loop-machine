import SwiftUI
import UIKit

/// App shell: one full-screen `BandView`; audio and sensors run only while the app is active.
@main
struct RezinaApp: App {
    @Environment(\.scenePhase) private var phase
    private let engine: Engine
    private let motion: Motion

    init() {
        let e = Engine()
        engine = e
        motion = Motion(engine: e)
    }

    var body: some Scene {
        WindowGroup {
            BandScreen(engine: engine)
                .ignoresSafeArea()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
                // touches near the edges go to the band first, not to Control Centre / home swipes
                .defersSystemGestures(on: .all)
                .onChange(of: phase) { _, now in active(now == .active) }
                .onAppear { active(true) }
        }
    }

    private func active(_ on: Bool) {
        UIApplication.shared.isIdleTimerDisabled = on // keep the screen on while playing
        if on {
            engine.start()
            motion.start()
        } else {
            motion.stop()
            engine.stop()
        }
    }
}

struct BandScreen: UIViewRepresentable {
    let engine: Engine
    func makeUIView(context: Context) -> BandView { BandView(engine: engine) }
    func updateUIView(_ view: BandView, context: Context) {}
}
