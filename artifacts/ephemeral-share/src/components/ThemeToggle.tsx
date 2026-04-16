import { Moon, Sun, Monitor } from "lucide-react"
import { useTheme } from "@/components/theme-provider"

const OPTIONS = [
  { value: "dark",   Icon: Moon,    label: "Dark"   },
  { value: "system", Icon: Monitor, label: "System" },
  { value: "light",  Icon: Sun,     label: "Light"  },
] as const

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div
      className="flex items-center border border-border rounded-sm overflow-hidden"
      role="group"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ value, Icon, label }) => {
        const active = theme === value
        return (
          <button
            key={value}
            onClick={() => setTheme(value)}
            aria-label={`${label} mode`}
            aria-pressed={active}
            title={`${label} mode`}
            className={[
              "flex items-center justify-center w-8 h-8 transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            ].join(" ")}
          >
            <Icon size={13} strokeWidth={active ? 2.5 : 1.75} />
          </button>
        )
      })}
    </div>
  )
}
