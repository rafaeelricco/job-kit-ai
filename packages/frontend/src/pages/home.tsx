export default HomePage

import { GridViewIcon } from "@hugeicons/core-free-icons"
import { Dashboard } from "@module/scout/components/dashboard"
import { Gaps } from "@module/scout/components/gaps"
import { StoreGate } from "@module/scout/components/store-gate"

function HomePage() {
  return (
    <StoreGate title="Home" Icon={GridViewIcon}>
      {(store) => (
        <>
          <Gaps gaps={store.gaps} />
          <Dashboard dossiers={store.dossiers} />
        </>
      )}
    </StoreGate>
  )
}
