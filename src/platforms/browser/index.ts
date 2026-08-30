import {
  chromiumAlarms,
  chromiumIdentity,
  chromiumNotifications,
  chromiumRuntime,
  chromiumStorage,
  chromiumTabs,
} from './chromium'
import {
  geckoAlarms,
  geckoIdentity,
  geckoNotifications,
  geckoRuntime,
  geckoStorage,
  geckoTabs,
} from './gecko'
import type { BrowserExtensionApi, BrowserTarget } from './types'

export type {
  BrowserExtensionApi,
  BrowserTarget,
  ExtensionAlarms,
  ExtensionIdentity,
  ExtensionNotificationOptions,
  ExtensionNotifications,
  ExtensionPort,
  ExtensionRuntime,
  ExtensionStorageArea,
  ExtensionTabs,
} from './types'

export { createChromiumApi } from './chromium'
export { createGeckoApi } from './gecko'

/**
 * Which engine this build targets.
 *
 * A BUILD-TIME constant. Vite's `define` replaces it with a string literal (see
 * vite.config.ts), so every comparison below folds and the other engine's
 * adapter is dropped from the bundle rather than shipped and skipped.
 *
 * Defaulting to 'chromium' rather than throwing is deliberate: Chromium is the
 * shipping target, and a build with no flag set should produce the shipping
 * product, not a broken one.
 */
export const BROWSER_TARGET: BrowserTarget =
  (import.meta.env.VITE_WATCHSIDE_BROWSER as BrowserTarget | undefined) ?? 'chromium'

/**
 * Which engine this bundle was built for.
 *
 * Exported because one product decision turns on it and nothing else should:
 * Firefox does not collect Mozilla’s optional technicalAndInteraction data, so
 * the analytics boundary suppresses that family on Gecko. Everything else in
 * this file exists to make the engine INVISIBLE to feature code; this is the
 * single, named exception, and it is consumed in exactly one place.
 */
export const IS_GECKO = BROWSER_TARGET === 'gecko'

/*
 * One picked const per namespace, not one picked object.
 *
 * A bundler cannot tree-shake individual properties off an object, so exporting
 * a single `ext` and nothing else would put `identity`, `notifications`,
 * `alarms` and `tabs` into the CONTENT SCRIPT - which only ever opens a port.
 * Exported separately, each bundle carries exactly the namespaces it calls.
 * tests/extension/browserAdapter.test.ts asserts that against the real built
 * output rather than trusting it.
 */
export const storage = IS_GECKO ? geckoStorage : chromiumStorage
export const identity = IS_GECKO ? geckoIdentity : chromiumIdentity
export const notifications = IS_GECKO ? geckoNotifications : chromiumNotifications
export const runtime = IS_GECKO ? geckoRuntime : chromiumRuntime
export const alarms = IS_GECKO ? geckoAlarms : chromiumAlarms
export const tabs = IS_GECKO ? geckoTabs : chromiumTabs

/**
 * The browser, as Watchside sees it.
 *
 * This module is the ONLY place in the product that knows which engine it is
 * running on. Everything downstream - auth, presence, the notifier, storage,
 * the port to each Twitch tab - takes what it needs from here or has it
 * injected, and contains no browser conditional of any kind.
 *
 * An object literal rather than a factory call, so a bundle that imports only
 * one namespace can still drop this.
 */
export const ext: BrowserExtensionApi = {
  storage,
  identity,
  notifications,
  runtime,
  alarms,
  tabs,
}
