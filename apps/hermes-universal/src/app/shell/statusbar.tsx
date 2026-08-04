import { useStatusbarContributions } from '@/app/contrib/surfaces'

import { useStatusbarItems } from './hooks/use-statusbar-items'
import { StatusbarControls } from './statusbar-controls'

// The connected bottom statusbar: assembles the item descriptors from stores
// (use-statusbar-items) + the `statusBar.*` contribution areas, and hands them to
// the dumb renderer. Mounted once, below the routed content, by MobileController.
export function Statusbar() {
  const extraLeftItems = useStatusbarContributions('left')
  const extraRightItems = useStatusbarContributions('right')

  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({ extraLeftItems, extraRightItems })

  return <StatusbarControls items={statusbarItems} leftItems={leftStatusbarItems} />
}
