import { useState } from 'react'
import { GROUP_ICONS } from '../../core/groupIcons'

/**
 * A group's face.
 *
 * One emoji, chosen from a short list. Groups are persistent social circles,
 * and a circle you recognise in a list at a glance feels more like a place
 * than a row of text does - but that is worth exactly one character, not an
 * upload pipeline. No file storage, no cropping, no moderation queue, no CDN.
 *
 * Optional by design: a group with no icon gets a neutral mark rather than a
 * randomly assigned one, so every group that existed before icons did looks
 * deliberate rather than broken.
 */

export function GroupIcon({ icon, size = 20 }: { icon: string | null; size?: number }) {
  return (
    <span
      className={`kb-group-icon${icon ? '' : ' kb-group-icon-empty'}`}
      style={{ fontSize: `${size}px`, width: `${size + 6}px`, height: `${size + 6}px` }}
      aria-hidden="true"
    >
      {/* A dot rather than a stand-in emoji: an icon nobody picked should not
          look like one somebody did. */}
      {icon ?? '•'}
    </span>
  )
}

export function GroupIconPicker({
  value,
  onPick,
  busy = false,
}: {
  value: string | null
  onPick: (icon: string | null) => void
  busy?: boolean
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        className="kb-icon-swatch"
        title="Change group icon"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <GroupIcon icon={value} />
      </button>
    )
  }

  return (
    <div className="kb-icon-picker" data-kb-nodrag>
      <div className="kb-icon-grid">
        {GROUP_ICONS.map((icon) => (
          <button
            type="button"
            key={icon}
            className={`kb-icon-choice${icon === value ? ' kb-icon-choice-on' : ''}`}
            title={icon}
            disabled={busy}
            onClick={() => {
              onPick(icon)
              setOpen(false)
            }}
          >
            {icon}
          </button>
        ))}
      </div>
      <div className="kb-icon-picker-actions">
        <button
          type="button"
          className="kb-ghost-btn kb-ghost-btn-inline"
          disabled={busy || value === null}
          onClick={() => {
            onPick(null)
            setOpen(false)
          }}
        >
          No icon
        </button>
        <button
          type="button"
          className="kb-ghost-btn kb-ghost-btn-inline"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
