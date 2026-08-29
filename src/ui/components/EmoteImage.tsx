import { useState } from 'react'
import { isKickbackEmote } from '../../core/emotes'
import type { Emote, KickbackEmoteId } from '../../core/emotes'

/**
 * Watchside's own emote artwork, drawn as inline SVG.
 *
 * Original shapes, not copies of anyone else's emotes, and inline rather than
 * fetched - a message can never point chat at a remote image, because there is
 * no image URL anywhere in this path.
 */

const FACES: Record<KickbackEmoteId, { bg: string; render: () => React.ReactNode }> = {
  lol: {
    bg: '#ffd45e',
    render: () => (
      <>
        <path d="M7 9.5 Q9.5 7.5 12 9.5" stroke="#3a2a00" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M12 9.5 Q14.5 7.5 17 9.5" stroke="#3a2a00" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M7 14 Q12 20 17 14 Z" fill="#3a2a00" />
        <path d="M6 11 L4.5 15" stroke="#6fc3ff" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M18 11 L19.5 15" stroke="#6fc3ff" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  pog: {
    bg: '#ff8452',
    render: () => (
      <>
        <ellipse cx="8.5" cy="10" rx="1.8" ry="2.4" fill="#2a1000" />
        <ellipse cx="15.5" cy="10" rx="1.8" ry="2.4" fill="#2a1000" />
        <ellipse cx="12" cy="16" rx="3" ry="4" fill="#2a1000" />
      </>
    ),
  },
  sad: {
    bg: '#9db4ff',
    render: () => (
      <>
        <circle cx="8.5" cy="10" r="1.6" fill="#122045" />
        <circle cx="15.5" cy="10" r="1.6" fill="#122045" />
        <path d="M8 17 Q12 13.5 16 17" stroke="#122045" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M8.5 12 L8.5 16" stroke="#6fc3ff" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
  },
  fire: {
    bg: '#ff4f5e',
    render: () => (
      <path
        d="M12 4 C14.5 8 17 9.5 17 13.5 A5 5 0 0 1 7 13.5 C7 11 8.5 10 9.5 8.5 C10 11 11 11.5 12 11 C11 9 11 6 12 4 Z"
        fill="#ffd45e"
      />
    ),
  },
  heart: {
    bg: '#ff5f8f',
    render: () => (
      <path
        d="M12 18 C7 14.5 5.5 12 5.5 9.8 A3.3 3.3 0 0 1 12 8.4 A3.3 3.3 0 0 1 18.5 9.8 C18.5 12 17 14.5 12 18 Z"
        fill="#fff"
      />
    ),
  },
  eyes: {
    bg: '#7de2d1',
    render: () => (
      <>
        <ellipse cx="8.5" cy="12" rx="3.2" ry="2.6" fill="#fff" />
        <ellipse cx="15.5" cy="12" rx="3.2" ry="2.6" fill="#fff" />
        <circle cx="9.4" cy="12" r="1.3" fill="#05302a" />
        <circle cx="16.4" cy="12" r="1.3" fill="#05302a" />
      </>
    ),
  },
  gg: {
    bg: '#2ee6a8',
    render: () => (
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="10"
        fontWeight="800"
        fill="#04291f"
        fontFamily="Inter, Arial, sans-serif"
      >
        GG
      </text>
    ),
  },
  oof: {
    bg: '#c98bff',
    render: () => (
      <>
        <path d="M6.5 9 L10.5 11" stroke="#25063f" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M17.5 9 L13.5 11" stroke="#25063f" strokeWidth="1.6" strokeLinecap="round" />
        <ellipse cx="12" cy="16" rx="2.6" ry="3.2" fill="#25063f" />
      </>
    ),
  },
  clap: {
    bg: '#54b8ff',
    render: () => (
      <>
        <path d="M7 15 L11 7" stroke="#04223d" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M11 16 L14 7" stroke="#04223d" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M15 16 L17.5 9" stroke="#04223d" strokeWidth="2.2" strokeLinecap="round" />
      </>
    ),
  },
  sus: {
    bg: '#ffb347',
    render: () => (
      <>
        <path d="M6.5 10 Q8.5 8.5 10.5 10" stroke="#3a1f00" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <circle cx="15.5" cy="10.5" r="1.7" fill="#3a1f00" />
        <path d="M8.5 16 Q12 14.5 15.5 16.5" stroke="#3a1f00" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </>
    ),
  },
}

export function EmoteImage({ emote, size = 18 }: { emote: Emote; size?: number }) {
  const [failed, setFailed] = useState(false)

  // External emotes are images from a provider CDN. The URL was derived from a
  // validated id, never taken from a payload, so there is nothing here a
  // provider could redirect. If it fails to load we fall back to the name
  // rather than leaving a hole in the conversation.
  if (!isKickbackEmote(emote)) {
    if (!emote.url || failed) {
      return <span className="kb-emote-fallback">{emote.name}</span>
    }
    return (
      <img
        className="kb-emote kb-emote-external"
        src={emote.url}
        alt={emote.name}
        title={emote.name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    )
  }

  const face = FACES[emote.id as KickbackEmoteId]
  if (!face) return <span className="kb-emote-fallback">{emote.name}</span>

  return (
    <svg
      className="kb-emote"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={emote.label}
    >
      <circle cx="12" cy="12" r="11" fill={face.bg} />
      {face.render()}
    </svg>
  )
}
