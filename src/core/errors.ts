/**
 * What a person is told when something fails.
 *
 * THE DEFECT THIS EXISTS TO REMOVE
 *
 * Every failure surface in the panel was written as:
 *
 *     setError(cause instanceof Error ? cause.message : 'Could not send that.')
 *
 * which reads as "show the real reason, and fall back to a sentence" - and does
 * the opposite of what it looks like. A thrown cause is almost always an Error,
 * so the sentence was the rare branch and the raw message was the normal one. In
 * practice a failed friend request showed somebody `TypeError: Failed to fetch`,
 * and a rejected insert could show a Postgres constraint name.
 *
 * The messages already written at every call site are good. They simply were not
 * being used.
 *
 * THE RULE
 *
 * The written sentence is what a person sees, always. The raw cause is for logs
 * and for the Feedback form, which already attaches diagnostics automatically -
 * so nothing is lost by keeping it out of the panel, and a user pasting a
 * stack-shaped string into a support email is not evidence anybody can act on.
 *
 * WHY NOT A GENERIC ERROR FRAMEWORK
 *
 * Because the interesting part of an error message is the sentence somebody
 * wrote for that specific failure, and a framework's job would be to replace
 * those with categories. One function, one rule, and the call sites keep saying
 * what they always said.
 */

/**
 * The sentence to show for a failure.
 *
 * `fallback` is not a fallback any more - it is the message. The parameter keeps
 * its name because every call site already passes exactly the right sentence,
 * and renaming it would have meant rewriting them all to say the same thing.
 *
 * @param cause  whatever was thrown. Deliberately unused for display.
 * @param fallback the sentence written for this particular failure.
 */
export function humanMessage(cause: unknown, fallback: string): string {
  void cause
  return fallback
}

/**
 * The shapes that mean a message was written for a machine: a stack frame, a
 * type name, a SQL constraint, a JSON blob, a URL.
 *
 * Named rather than inlined so the check is one readable line at the call site
 * - and so a mutation can remove it cleanly, which is how it is proved to be
 * load-bearing.
 */
const JARGON = /\bat\s+\w+\s*\(|Error:|TypeError|\bnull\b|constraint|[{}[\]]|https?:\/\//i

/**
 * The same, for a failure whose message the SERVER wrote for a person.
 *
 * A handful of paths - account deletion, permission grants - return a string
 * that was composed to be read, not a database error. Those pass the string
 * itself rather than a thrown cause, so they never go through `humanMessage`;
 * this exists to name the distinction rather than leave it implied.
 *
 * Anything longer than a sentence, or containing the shape of a stack trace or
 * a type name, is refused: a server that starts leaking internals should degrade
 * to the written sentence rather than pass them through.
 */
export function serverMessage(message: string | null | undefined, fallback: string): string {
  if (!message) return fallback
  const clean = message.trim()
  if (clean.length === 0 || clean.length > 160) return fallback
  if (JARGON.test(clean)) return fallback
  return clean
}
