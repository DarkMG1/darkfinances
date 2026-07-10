const test = require('node:test');
const assert = require('node:assert/strict');
const { applyBuildVersion, applySwiftPatch } = require('../plugins/with-ios-privacy-shield');

const delegate = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  // Linking API
}
`;

test('privacy shield injection is complete and idempotent', () => {
  const first = applySwiftPatch(delegate);
  assert.match(first, /import UIKit/);
  assert.match(first, /applicationWillResignActive/);
  assert.match(first, /applicationDidBecomeActive/);
  assert.match(first, /private var privacyShield/);
  assert.equal(applySwiftPatch(first), first);
});

test('privacy shield injection fails loudly when Expo changes an anchor', () => {
  assert.throws(
    () => applySwiftPatch(delegate.replace('  // Linking API', '  // Changed upstream anchor')),
    /method anchor/
  );
});

test('main app and extension build settings stay version-aligned', () => {
  const section = {
    app: { buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: 'dev.example.app', CURRENT_PROJECT_VERSION: 1 } },
    widget: { buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: 'dev.example.app.widget', CURRENT_PROJECT_VERSION: 1 } },
    comment: 'ignored',
  };
  applyBuildVersion(section, '3', '1.1.0');
  assert.equal(section.app.buildSettings.CURRENT_PROJECT_VERSION, '3');
  assert.equal(section.widget.buildSettings.CURRENT_PROJECT_VERSION, '3');
  assert.equal(section.widget.buildSettings.MARKETING_VERSION, '1.1.0');
});
