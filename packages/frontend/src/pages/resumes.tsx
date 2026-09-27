export default ResumesPage

import { File01Icon } from "@hugeicons/core-free-icons"
import { ProfileGate } from "@module/profile/components/profile-gate"
import { ResumeList } from "@module/profile/components/resume"

function ResumesPage() {
  return (
    <ProfileGate title="Resumes" Icon={File01Icon}>
      {(profile, save) => (
        <ResumeList resumes={profile.resumes} adaptPerVacancy={profile.adaptPerVacancy} save={save} />
      )}
    </ProfileGate>
  )
}
