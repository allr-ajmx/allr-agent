// Central icon module — mirrors the desktop `@/lib/icons` seam so ported
// components can `import { X } from '@/lib/icons'` unchanged. Backed by
// @tabler/icons-react (the desktop icon library). Icons are aliased to the
// desktop names and re-exported; grow this list as more get referenced.
import type { ComponentType } from 'react'

// Structural icon type (matches the desktop `IconComponent`) so ported nav /
// settings components type their icon props identically.
export type IconComponent = ComponentType<{ className?: string }>

export {
  IconActivity as Activity,
  // Notification toasts (Track I)
  IconAlertCircle as AlertCircle,
  IconAlertTriangle as AlertTriangle,
  IconArchive as Archive,
  IconArchiveOff as ArchiveOff,
  // Composer (Phase 7 chat-UI port) — aliased to the exact names the desktop
  // composer imports so the ported files resolve unchanged.
  IconArrowUp as ArrowUp,
  IconArrowUpRight as ArrowUpRight,
  IconWaveSine as AudioLines,
  IconChartBar as BarChart3,
  IconBell as Bell,
  IconBookmark as Bookmark,
  IconBookmarkFilled as BookmarkFilled,
  IconBox as Box,
  // Settings section icons (Track J)
  IconBrain as Brain,
  IconCheck as Check,
  IconCircleCheck as CheckCircle2,
  IconChevronDown as ChevronDown,
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
  IconChevronUp as ChevronUp,
  IconCircleFilled as Circle,
  IconCircleLetterA as CircleLetterA,
  IconClipboard as Clipboard,
  IconClock as Clock,
  IconCloud as Cloud,
  // Status bar (Track F — bottom statusbar port)
  IconCommand as Command,
  // Chat rendering pipeline (chat-session UI port)
  IconCopy as Copy,
  IconCpu as Cpu,
  IconDownload as Download,
  // Memory provider panels (config sections port)
  IconExternalLink as ExternalLink,
  IconEye as Eye,
  IconEyeOff as EyeOff,
  IconFile as File,
  IconPhoto as FileImage,
  IconFileText as FileText,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconGitBranch as GitBranch,
  IconGitBranch as GitBranchIcon,
  // Language switcher / theme picker (Track I). Globe = IconGlobe to match the
  // desktop `@/lib/icons` alias exactly (the meridian globe, not IconWorld).
  IconGlobe as Globe,
  IconHash as Hash,
  // Gateway settings (mode-card hint + sign-in buttons)
  IconHelpCircle as HelpCircle,
  IconHistory as History,
  IconPhoto as ImageIcon,
  IconInfoCircle as Info,
  IconKey as Key,
  IconKeyboard as Keyboard,
  IconLayersIntersect2 as Layers3,
  IconLayoutDashboard as LayoutDashboard,
  IconLayoutGrid as LayoutGrid,
  IconLink as Link,
  IconLink as Link2,
  IconLoader2 as Loader2,
  // Chat message action bar / user bubble (Phase 4 chat-UI port) — aliased to
  // the exact names desktop's assistant-message / user-message import.
  IconLoader2 as Loader2Icon,
  IconLock as Lock,
  IconLogin as LogIn,
  // Zoomable viewer (embeds phase — mermaid/svg pan-zoom toolbar)
  IconMaximize as Maximize,
  // Navigation glyphs (Track F sidebar)
  IconMenu2 as Menu,
  IconMessageCircle as MessageCircle,
  // Tool / clarify glyphs (chat-port phase 5)
  IconMessageQuestion as MessageQuestion,
  IconMessage2 as MessageSquareText,
  IconMicrophone as Mic,
  IconDeviceDesktop as Monitor,
  IconMoon as Moon,
  IconDotsVertical as MoreVertical,
  // Notifications completion-sound preview
  // Plugins (MJX-53): Package heads the Settings ▸ Plugins page (desktop parity);
  // Plug is the nav-rail icon + the fallback for a contributed command / nav row
  // that ships none.
  IconPackage as Package,
  IconPalette as Palette,
  IconPaw as Paw,
  IconPencil as Pencil,
  IconPlayerPlay as Play,
  IconPlug as Plug,
  IconPlus as Plus,
  IconRefresh as Refresh,
  IconRefresh as RefreshCw,
  IconDeviceFloppy as Save,
  IconSearch as Search,
  IconSend as Send,
  IconSettings as Settings,
  IconSparkles as Sparkles,
  IconSquare as Square,
  IconSquareFilled as SquareFilled,
  IconStars as Stars,
  IconSteeringWheel as SteeringWheel,
  IconPlayerStopFilled as StopFilled,
  IconSun as Sun,
  IconTerminal2 as Terminal,
  // Session actions (Track H)
  IconTrash as Trash,
  IconTrash as Trash2,
  IconUpload as Upload,
  IconUsers as Users,
  IconVolume2 as Volume2,
  IconVolume as Volume2Icon,
  IconVolumeOff as VolumeX,
  IconVolumeOff as VolumeXIcon,
  IconTool as Wrench,
  IconX as X,
  IconX as XIcon,
  IconBolt as Zap,
  IconBoltFilled as ZapFilled,
  IconZoomIn as ZoomIn,
  IconZoomOut as ZoomOut
} from '@tabler/icons-react'

// Shared icon-size utility (mirrors desktop `@/lib/icons` iconSize) so ported
// components can size glyphs with `className={iconSize.sm}`.
export const iconSize = {
  xs: 'size-3', // 12px
  sm: 'size-3.5', // 14px
  md: 'size-4', // 16px
  lg: 'size-5', // 20px
  xl: 'size-6' // 24px
} as const

export type IconSize = keyof typeof iconSize
