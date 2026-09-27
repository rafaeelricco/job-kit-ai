export { AppSidebar }

import { useEffect } from "react"
import { NavLink, useLocation, useSearchParams } from "react-router-dom"
import {
  Briefcase01Icon,
  File01Icon,
  FolderOpenIcon,
  GridViewIcon,
  LibraryIcon,
  Logout01Icon,
  QuoteDownIcon,
  Settings02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/dropdown-menu"
import { useAccess } from "@module/access/use-access"
import { useIdentity } from "@module/profile/helpers/use-identity"
import { signOut } from "@module/session/session"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@ui/sidebar"

// A one-word name has no second initial to take, so it falls back to its first
// two letters rather than rendering a lonely "S".
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/)
  const letters = words.length > 1 ? words.map((word) => word[0] ?? "").join("") : (words[0] ?? "").slice(0, 2)
  return letters.slice(0, 2).toUpperCase()
}

const MAIN = [
  { label: "Home", Icon: GridViewIcon, to: "/" },
  { label: "Dossiers", Icon: Briefcase01Icon, to: "/dossiers" },
  { label: "Resumes", Icon: File01Icon, to: "/resumes" },
  { label: "Recommendations", Icon: QuoteDownIcon, to: "/recommendations" },
  { label: "Answers", Icon: LibraryIcon, to: "/answers" },
] as const

function AppSidebar() {
  const { pathname, search } = useLocation()
  const { setOpenMobile } = useSidebar()

  // Mobile sidebar is a controlled sheet. Navigating without closing it leaves
  // the destination under the drawer until the user dismisses it by hand.
  // Settings opens on the search string alone, so watching `pathname` would
  // leave the drawer stacked under the dialog.
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, search, setOpenMobile])

  return (
    <Sidebar collapsible="icon">
      {/* Icon mode leaves a 3rem rail; 12px of padding would squash the mark. */}
      <SidebarHeader className="p-3 group-data-[collapsible=icon]:p-2">
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <img
            src={`${import.meta.env.BASE_URL}brand/mascot-mark.svg`}
            alt=""
            className="size-7 shrink-0 object-contain dark:hidden"
          />
          {/* Ink #1d1d1d is 1.00:1 on the dark card; the dark mark carries a
              light keyline so the hair silhouette survives on black. */}
          <img
            src={`${import.meta.env.BASE_URL}brand/mascot-mark-dark.svg`}
            alt=""
            className="hidden size-7 shrink-0 object-contain dark:block"
          />
          <span className="truncate font-logo text-sm font-bold tracking-wide uppercase group-data-[collapsible=icon]:hidden">
            Job Kit AI
          </span>
          <SidebarTrigger className="ml-auto group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarHeader>

      {/* The extra px-1 stacks with the group's own padding and pushes the
          collapsed rail's icons off-centre, so icon mode drops it. */}
      <SidebarContent className="gap-1 px-1 group-data-[collapsible=icon]:px-0">
        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN.map((item) => (
                <SidebarMenuItem key={item.label}>
                  {/* Rows are 32px tall with a 14px label at --ink-body; the active row sits at --ink-strong over an 8% fill. */}
                  <SidebarMenuButton
                    isActive={pathname === item.to}
                    tooltip={item.label}
                    className="h-8 gap-2 rounded-[6px] px-2 text-sm font-normal text-ink-body data-active:text-ink-strong"
                    render={<NavLink to={item.to} />}
                  >
                    <HugeiconsIcon icon={item.Icon} aria-hidden="true" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

// Account settings, appearance and the folder switch are utility navigation,
// not destinations: NN/G puts primary nav on the left rail and everything about
// the person behind one identity affordance. Each row here does something the
// app can actually do. Sign-out clears the session at once; the gate then redirects.
function AccountMenu() {
  const identity = useIdentity()
  const { changeFolder } = useAccess()
  const [params] = useSearchParams()
  const settingsOpen = params.has("settings")

  // Before a folder is chosen there is no name to show, and the sidebar renders
  // above the access gate, so the product name stands in rather than an empty
  // avatar or a fake user.
  const name = identity?.name.trim() === "" || identity === null ? "Job Kit" : identity.name
  const detail = identity === null ? "No profile folder" : identity.email

  const repick = (): void => {
    void changeFolder().then((result) => {
      if (result.kind === "err") {
        if (result.error.kind === "aborted") return
        toast.error("Could not open that folder. Pick the profile folder again.")
        return
      }
      // The whole app reads from the folder that just changed, and every hook
      // that holds it loads once per mount, so a reload is the honest refresh.
      window.location.reload()
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="lg" className="gap-2.5 data-[popup-open]:bg-sidebar-accent" />}
      >
        <Avatar className="size-8">
          <AvatarFallback className="text-xs">{initialsOf(name)}</AvatarFallback>
        </Avatar>
        <div className="grid flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </div>
        <HugeiconsIcon icon={UnfoldMoreIcon} className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">{initialsOf(name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{detail}</span>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            data-active={settingsOpen}
            render={<NavLink to={{ search: "?settings=profile" }} state={{ settingsPushed: true }} />}
            className="data-active:bg-accent"
          >
            <HugeiconsIcon icon={Settings02Icon} aria-hidden="true" />
            Account settings
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={repick}>
            <HugeiconsIcon icon={FolderOpenIcon} aria-hidden="true" />
            Change profile folder
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={signOut}>
            <HugeiconsIcon icon={Logout01Icon} aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
