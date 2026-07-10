const { withAppDelegate, withXcodeProject } = require('@expo/config-plugins');

const PROPERTY = '  private var privacyShield: UIView?\n';

const METHODS = `
  public override func applicationWillResignActive(_ application: UIApplication) {
    showPrivacyShield()
    super.applicationWillResignActive(application)
  }

  public override func applicationDidBecomeActive(_ application: UIApplication) {
    super.applicationDidBecomeActive(application)
    hidePrivacyShield()
  }

  private func showPrivacyShield() {
    guard privacyShield == nil, let window else {
      return
    }

    let shield = UIView(frame: window.bounds)
    shield.backgroundColor = UIColor(red: 0.039, green: 0.039, blue: 0.059, alpha: 1)
    shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    let card = UIView()
    card.translatesAutoresizingMaskIntoConstraints = false
    card.backgroundColor = UIColor(red: 0.067, green: 0.067, blue: 0.094, alpha: 1)
    card.layer.cornerRadius = 24
    card.layer.borderWidth = 1
    card.layer.borderColor = UIColor.white.withAlphaComponent(0.08).cgColor

    let title = UILabel()
    title.translatesAutoresizingMaskIntoConstraints = false
    title.font = UIFont.systemFont(ofSize: 28, weight: .bold)
    title.textAlignment = .center
    let titleText = NSMutableAttributedString(
      string: "dark",
      attributes: [.foregroundColor: UIColor(red: 0.941, green: 0.941, blue: 0.961, alpha: 1)]
    )
    titleText.append(NSAttributedString(
      string: "finances",
      attributes: [.foregroundColor: UIColor(red: 0.659, green: 0.596, blue: 1.0, alpha: 1)]
    ))
    title.attributedText = titleText

    let subtitle = UILabel()
    subtitle.translatesAutoresizingMaskIntoConstraints = false
    subtitle.text = "PRIVATE FINANCES"
    subtitle.font = UIFont.systemFont(ofSize: 13, weight: .bold)
    subtitle.textColor = UIColor(red: 0.42, green: 0.42, blue: 0.50, alpha: 1)
    subtitle.textAlignment = .center

    card.addSubview(title)
    card.addSubview(subtitle)
    shield.addSubview(card)
    window.addSubview(shield)

    NSLayoutConstraint.activate([
      card.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
      card.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
      card.leadingAnchor.constraint(greaterThanOrEqualTo: shield.leadingAnchor, constant: 36),
      card.trailingAnchor.constraint(lessThanOrEqualTo: shield.trailingAnchor, constant: -36),
      title.topAnchor.constraint(equalTo: card.topAnchor, constant: 26),
      title.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 30),
      title.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -30),
      subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
      subtitle.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 30),
      subtitle.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -30),
      subtitle.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -26)
    ])

    privacyShield = shield
    window.bringSubviewToFront(shield)
    window.layoutIfNeeded()
  }

  private func hidePrivacyShield() {
    privacyShield?.removeFromSuperview()
    privacyShield = nil
  }
`;

function applySwiftPatch(contents) {
  let next = contents;
  if (!next.includes('import UIKit')) {
    if (!next.includes('import ReactAppDependencyProvider\n')) throw new Error('Privacy shield plugin could not find the import anchor');
    next = next.replace('import ReactAppDependencyProvider\n', 'import ReactAppDependencyProvider\nimport UIKit\n');
  }
  if (!next.includes('private var privacyShield')) {
    if (!next.includes('  var window: UIWindow?\n')) throw new Error('Privacy shield plugin could not find the window property anchor');
    next = next.replace('  var window: UIWindow?\n', `  var window: UIWindow?\n${PROPERTY}`);
  }
  if (!next.includes('showPrivacyShield()')) {
    if (!next.includes('\n  // Linking API')) throw new Error('Privacy shield plugin could not find the method anchor');
    next = next.replace('\n  // Linking API', `${METHODS}\n  // Linking API`);
  }
  for (const required of ['import UIKit', 'private var privacyShield', 'applicationWillResignActive', 'applicationDidBecomeActive', 'showPrivacyShield()', 'hidePrivacyShield()']) {
    if (!next.includes(required)) throw new Error(`Privacy shield plugin failed to inject ${required}`);
  }
  return next;
}

function applyBuildVersion(section, buildNumber, marketingVersion) {
  for (const value of Object.values(section)) {
    const settings = value && typeof value === 'object' ? value.buildSettings : null;
    if (!settings || !settings.PRODUCT_BUNDLE_IDENTIFIER) continue;
    settings.CURRENT_PROJECT_VERSION = String(buildNumber);
    settings.MARKETING_VERSION = String(marketingVersion);
  }
}

module.exports = function withIosPrivacyShield(config) {
  let next = withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') throw new Error('Privacy shield requires a Swift AppDelegate');
    config.modResults.contents = applySwiftPatch(config.modResults.contents);
    return config;
  });
  next = withXcodeProject(next, (config) => {
    applyBuildVersion(
      config.modResults.pbxXCBuildConfigurationSection(),
      config.ios?.buildNumber || '1',
      config.version || '1.0.0',
    );
    return config;
  });
  return next;
};

module.exports.applySwiftPatch = applySwiftPatch;
module.exports.applyBuildVersion = applyBuildVersion;
