import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

/**
 * If Watchside breaks, it must get out of the way rather than take Twitch with
 * it: render nothing and leave the page untouched.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Watchside] panel crashed, hiding it', error, info)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
