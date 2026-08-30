/**
 * The brand, as values, for everything that is not the panel stylesheet.
 *
 * src/ui/kickback.css owns the panel's `--kb-*` custom properties and is the
 * authority for the PRODUCT. This file is the authority for everything the
 * product does not render: social templates, store artwork, and any future
 * marketing surface. The two agree by convention and by review, not by import,
 * because a CSS file injected into a shadow root and a Node script generating
 * a 2560x1440 PNG have no sensible way to share a runtime.
 *
 * The colours here are the same values, written once, so a marketing asset can
 * never be "nearly" on-brand.
 */
import { VIOLET, GROUND } from './geometry.mjs'

export const COLOR = {
  /** Near-black, neutral. Not navy - the old identity's ground was blue-tinted. */
  ground: GROUND,
  surface: '#131318',
  raised: '#1a1a21',
  line: '#26262f',

  /** One step off Twitch purple, deliberately. See geometry.mjs. */
  violet: VIOLET,
  violetDeep: '#6d28d9',
  violetDim: '#3b1d63',

  text: '#f5f5f7',
  dim: '#9c9ca8',
  faint: '#6b6b78',
  onAccent: '#ffffff',

  /** Semantic, shared with the product, never re-hued for decoration. */
  here: '#2ee6a8',
  live: '#e91916',
}

export const GRADIENT = `linear-gradient(135deg, ${COLOR.violet}, ${COLOR.violetDeep})`

/** The single glow. One definition here for the same reason as in the panel. */
export const GLOW = `0 0 60px rgba(168, 85, 247, 0.35)`

/**
 * Typography.
 *
 * Two faces, split by job. Inter runs the product because it is correct for
 * dense 13px social rows and is already loaded there. Outfit is a geometric
 * sans used ONLY on brand surfaces - the wordmark, headlines, marketing - which
 * is where a voice is worth having and where legibility at 13px is not the
 * constraint.
 */
export const FONT = {
  display: "'Outfit', 'Poppins', 'Inter', system-ui, sans-serif",
  body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Loaded by the social renderer; the product loads nothing extra. */
  webfont:
    'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap',
}

/** The messages, so no template retypes them and gets one subtly wrong. */
export const COPY = {
  wordmark: 'watchside',
  primary: "See who's watching. Join together.",
  secondary: 'The social layer for Twitch.',
  /*
   * NO DOMAIN, deliberately.
   *
   * The brand board mocks up 'watchside.app', but nothing in this repository
   * establishes that we own or control it, and a public asset that prints an
   * unowned address is either a dead link or an advert for somebody else. The
   * templates therefore print no URL at all rather than guessing one.
   *
   * The addresses we demonstrably control today are the Chrome Web Store
   * listing and anoteros-labs.github.io/watchside/. Either could go here once
   * that is a decision somebody has made rather than an assumption a template
   * inherited from a mock.
   */
  domain: null,
}

/**
 * The background texture used across social surfaces.
 *
 * A dot grid and two soft violet blooms, as CSS gradients rather than imagery -
 * so it scales to any canvas, weighs nothing, and cannot go missing. This is
 * the "restrained gamer-native" cue from the brand direction; there is exactly
 * one of it, and templates compose it rather than inventing their own.
 */
export function backdrop({ dots = true } = {}) {
  const layers = [
    `radial-gradient(1200px 600px at 12% -10%, rgba(168,85,247,0.28), transparent 60%)`,
    `radial-gradient(900px 500px at 100% 110%, rgba(109,40,217,0.30), transparent 60%)`,
  ]
  if (dots) {
    layers.push(
      `radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px)`,
    )
  }
  return {
    backgroundImage: layers.join(', '),
    backgroundSize: dots ? 'auto, auto, 26px 26px' : 'auto, auto',
    backgroundColor: COLOR.ground,
  }
}

/** `backdrop()` as a CSS declaration block, for template literals. */
export function backdropCss(options) {
  const b = backdrop(options)
  return [
    `background-color:${b.backgroundColor}`,
    `background-image:${b.backgroundImage}`,
    `background-size:${b.backgroundSize}`,
  ].join(';')
}
