import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "00:00:00"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (d > 0) {
    return `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

export interface TtlOption {
  label: string
  value: number
}

export const TTL_OPTIONS: TtlOption[] = [
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "30 min", value: 1800 },
  { label: "1 hr", value: 3600 },
  { label: "4 hr", value: 14400 },
  { label: "24 hr", value: 86400 },
  { label: "4 days", value: 345600 },
]

export function generatePassword(): string {
  const adjectives = ["crimson", "silent", "hidden", "dark", "neon", "cyan", "amber", "phantom", "ghost", "void", "stellar", "quantum", "iron", "steel", "glass", "velvet", "frost", "shadow", "cobalt", "obsidian"]
  const nouns = ["falcon", "vault", "lock", "key", "cipher", "matrix", "nexus", "pulse", "spark", "echo", "shard", "prism", "forge", "shield", "core", "node", "blade", "wing", "wire", "grid"]
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const num = Math.floor(Math.random() * 90) + 10
  return `${adj}-${noun}-${num}`
}

export interface HumorEntry {
  title: string
  subtitle: string
}

const HUMOR: HumorEntry[] = [
  { title: "We can't find what you're looking for", subtitle: "Like smoke in the wind, it's gone." },
  { title: "No droids here", subtitle: "These aren't the files you're looking for." },
  { title: "There is no cake", subtitle: "The promise was real. The data was not." },
  { title: "This share has evaporated", subtitle: "Poof. Into the digital ether." },
  { title: "Signal lost", subtitle: "This message, if it ever existed, has self-destructed." },
  { title: "404: Bits have fled the building", subtitle: "Elvis and your data have left the server." },
]

export function randomHumorous(): HumorEntry {
  return HUMOR[Math.floor(Math.random() * HUMOR.length)]
}

export function base64ToBuffer(base64: string): Uint8Array {
  const binaryString = window.atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return window.btoa(binary)
}

export function base64UrlEncode(buffer: Uint8Array): string {
  return bufferToBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  return base64ToBuffer(base64)
}
