import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TestLab } from './TestLab'
import { assertTestLabBuild, sealNetwork } from './safety'
import '../ui/kickback.css'
import './testlab.css'

/**
 * Test Lab entry point.
 *
 * Order matters: refuse to run outside a Test Lab build, then cut the page off
 * from the network, and only then load a simulated world. Nothing simulated
 * exists while there is still a way for it to leave.
 */

assertTestLabBuild(import.meta.env.VITE_KICKBACK_MODE)

sealNetwork((attempt) => {
  console.error(`Kickback Test Lab blocked ${attempt.api} to ${attempt.target}`)
})

const root = document.getElementById('lab-root')
if (!root) throw new Error('Kickback Test Lab: no #lab-root in the page')

createRoot(root).render(
  <StrictMode>
    <TestLab />
  </StrictMode>,
)
