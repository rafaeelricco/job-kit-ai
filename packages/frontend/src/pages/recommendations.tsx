export default RecommendationsPage

import { QuoteDownIcon } from "@hugeicons/core-free-icons"
import { ProfileGate } from "@module/profile/components/profile-gate"
import { RecommendationList } from "@module/profile/components/recommendation"

function RecommendationsPage() {
  return (
    <ProfileGate title="Recommendations" Icon={QuoteDownIcon}>
      {(profile) => <RecommendationList items={profile.recommendations} />}
    </ProfileGate>
  )
}
