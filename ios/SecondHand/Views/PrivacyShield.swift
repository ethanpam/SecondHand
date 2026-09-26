import SwiftUI
import UIKit

/// Places the privacy cover above presented editors and Quick Look, including app-switcher snapshots.
struct PrivacyShield: UIViewRepresentable {
    func makeUIView(context: Context) -> PrivacyShieldObserver { PrivacyShieldObserver() }
    func updateUIView(_ uiView: PrivacyShieldObserver, context: Context) {}
    static func dismantleUIView(_ uiView: PrivacyShieldObserver, coordinator: ()) {
        uiView.detach()
    }
}

@MainActor
final class PrivacyShieldObserver: UIView {
    private var cover: UIView?

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        // UIKit posts these lifecycle notifications on the main thread. Selector delivery
        // is synchronous so the cover is installed before a snapshot can be captured.
        NotificationCenter.default.addObserver(self, selector: #selector(showCover), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(removeCover), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { removeCover() }
        else if UIApplication.shared.applicationState != .active { showCover() }
    }

    @objc private func showCover() {
        guard cover == nil, let window else { return }
        let shield = UIView(frame: window.bounds)
        shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        shield.backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark ? .systemBackground : UIColor(red: 0.97, green: 0.96, blue: 0.93, alpha: 1)
        }
        shield.isOpaque = true
        shield.isAccessibilityElement = false
        shield.accessibilityElementsHidden = true

        let icon = UIImageView(image: UIImage(systemName: "hand.raised.fingers.spread.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 48)))
        icon.contentMode = .scaleAspectFit
        icon.tintColor = UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(red: 0.49, green: 0.79, blue: 0.68, alpha: 1) : UIColor(red: 0.17, green: 0.39, blue: 0.32, alpha: 1)
        }
        let title = UILabel()
        title.text = "Second Hand"
        title.font = .preferredFont(forTextStyle: .title2)
        title.textColor = .label
        title.textAlignment = .center
        let subtitle = UILabel()
        subtitle.text = "A little support. All yours."
        subtitle.font = .preferredFont(forTextStyle: .subheadline)
        subtitle.textColor = .secondaryLabel
        subtitle.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [icon, title, subtitle])
        stack.axis = .vertical
        stack.spacing = 18
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        shield.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: shield.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: shield.trailingAnchor, constant: -24)
        ])
        window.addSubview(shield)
        cover = shield
    }

    @objc private func removeCover() {
        cover?.removeFromSuperview()
        cover = nil
    }

    func detach() {
        removeCover()
        NotificationCenter.default.removeObserver(self)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
