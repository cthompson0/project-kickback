/**
 * Types for assets/brand/geometry.mjs.
 *
 * The geometry is plain ESM so packaging scripts can import it without a build
 * step, but src/ui/components/Icons.tsx imports it too - and a logo typed as
 * `any` is a poor place to lose type safety.
 */

export interface MarkStroke {
  id: string
  d: string
  width: number
  color: string
}

export interface MarkFill {
  id: string
  d: string
  color: string
}

export interface MarkCircle {
  id: string
  cx: number
  cy: number
  r: number
  fill: string
}

export interface MarkVariant {
  ground: string
  radius: number
  strokes: MarkStroke[]
  fills: MarkFill[]
  circles: MarkCircle[]
}

export declare const GROUND: string
export declare const VIOLET: string
export declare const CORNER: number
export declare const SMALL_UP_TO: number
export declare const MARK: { full: MarkVariant; small: MarkVariant }

export declare const EXTENSION_SIZES: number[]
export declare const BRAND_SIZES: number[]
export declare const ICON_SIZES: number[]

export declare function iconPath(size: number): string
export declare function variantFor(size: number): 'full' | 'small'
export declare function markSvg(
  variant?: 'full' | 'small',
  options?: { ground?: boolean; size?: number },
): string
