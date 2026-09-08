/*
 * THE CAMPAIGN LANDING PAGE'S ONE BEHAVIOUR.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The campaign code has to reach the extension, and the only route it has is
 * the visitor arriving on twitch.tv carrying ?watchside_campaign=<code>, where
 * the content script already runs. The browser store sits in the middle of that
 * journey and is not ours: click "Add to Chrome" in the same tab and this page
 * - and with it the only link that carries the code - is gone.
 *
 * So the store links open in a new tab (set in the markup, not here) and this
 * script does one thing: once a store has been chosen, it promotes the
 * continue-to-Twitch step from a quiet afterthought to the obvious next action.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No storage of any kind - no cookie, no localStorage, no sessionStorage. No
 * network request. No identifier, generated or otherwise. No timing, no
 * referrer, no user agent, no measurement of the visitor at all. It reads one
 * click on one of two known links and adds a CSS class.
 *
 * WORKS WITHOUT JAVASCRIPT. The continue block is rendered visible and complete
 * in the HTML; this only emphasises it. If the script never runs the whole
 * journey still works, which matters because the attribution chain would
 * otherwise break silently for anybody blocking scripts - and those are exactly
 * the people most likely to be blocking them.
 *
 * THE DESTINATION IS BAKED, NOT COMPUTED. The continue link's href is written
 * at build time from the campaign this page was generated for. Nothing here
 * reads the URL, so there is nothing for a crafted link to change.
 */
;(function () {
  var chosen = false

  function promote() {
    if (chosen) return
    chosen = true

    var block = document.getElementById('continue-block')
    if (block) block.className = 'continue continue-live'

    var lead = document.getElementById('continue-lead')
    if (lead) lead.textContent = 'Installed? Continue to Twitch to finish setting up.'
  }

  var links = document.querySelectorAll('[data-store]')
  for (var index = 0; index < links.length; index += 1) {
    links[index].addEventListener('click', promote)
  }
})()
