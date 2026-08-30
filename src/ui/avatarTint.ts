/**
 * A stable tint for anything that has no picture.
 *
 * Its own module rather than an export from Avatar.tsx, for two reasons. Fast
 * refresh wants a component file to export only components - but more usefully,
 * this is now shared by two DIFFERENT identities: a Watchside user and a Twitch
 * channel. Neither owns it.
 *
 * The two must look consistent without being the same thing. A friend's avatar
 * and the avatar of the channel they are watching sit inches apart on a Gravity
 * card, and showing one in the other's place would be a lie about who is
 * streaming - so they share this function and nothing else.
 */

/*
 * Eight hues that are distinguishable from each other AND from the brand.
 *
 * The second constraint arrived with the violet identity. This palette used to
 * contain #c98bff, a light violet, which sat close enough to the accent that a
 * person with no picture read as a Watchside element rather than as a person -
 * exactly the confusion an identity colour exists to prevent. It is now lime,
 * which nothing else in the product uses.
 *
 * The rest were left alone. They are person colours, not brand colours, and
 * variety is the whole point; #ff8452 is warm, and that is fine on a face.
 */
const PALETTE = [
  '#ff8452',
  '#54b8ff',
  '#2ee6a8',
  '#b6e356',
  '#ffd45e',
  '#ff5f8f',
  '#7de2d1',
  '#9db4ff',
]

/**
 * Pick a colour from a seed.
 *
 * Deterministic, so the same person or channel is the same colour on every
 * device and after every reload. A random tint would make the panel look
 * subtly different every time it opened.
 */
export function avatarTint(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}
