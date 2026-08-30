/**
 * The avatar size scale.
 *
 * Three steps, chosen by how much room a person is given rather than by which
 * component happens to be rendering them. The same idea used to be written as
 * 18, 20, 22 and 30 across eight files, and most of those differences were
 * accidents rather than hierarchy.
 *
 * Every value is a multiple of 4, which is not decoration. A circle only
 * rasterises cleanly when its diameter lands on whole device pixels, and
 * multiples of 4 are the only integers that stay whole at every display scale
 * Windows offers (125%, 150%, 175%, 200%, 225%, 250%, 300%). At 125% - the
 * most common scaled setting - the previous 18, 22 and 30 resolved to 22.5,
 * 27.5 and 37.5 device pixels, so the two sides of each circle could not both
 * sit on a pixel boundary.
 */
export const AVATAR_SIZE = {
  /** A person on their own line, with their name: friend lists, search, groups. */
  row: 32,
  /** A person inside a card or the header - named, but secondary to a row. */
  person: 24,
  /** A person in an overlapping stack: unnamed, deliberately dense. */
  stack: 20,
} as const
