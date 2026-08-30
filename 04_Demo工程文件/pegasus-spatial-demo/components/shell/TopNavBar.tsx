'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useChatContext } from '@/contexts/ChatContext'
import { BrandMark } from './BrandMark'

const STATIC_NAV_LINKS = [
  { href: '/', label: '空间工作台' },
  { href: '/library', label: '项目库' },
  { href: '/store', label: '记忆' },
]

export function TopNavBar() {
  const pathname = usePathname()
  const { conversationId } = useChatContext()
  const navLinks = conversationId
    ? [
        STATIC_NAV_LINKS[0],
        { href: `/spatial/${encodeURIComponent(conversationId)}`, label: '空间舞台' },
        ...STATIC_NAV_LINKS.slice(1),
      ]
    : STATIC_NAV_LINKS

  return (
    <nav data-fluid-interaction="ignore" className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-[var(--glass-panel-border)] bg-[color-mix(in_srgb,var(--glass-panel-bg)_70%,transparent)] px-8 backdrop-blur-xl">
      <div className="flex items-center gap-9">
        <Link href="/" className="group flex items-center gap-2.5">
          <BrandMark className="h-8 w-8 transition-transform group-hover:scale-105" />
          <span className="text-lg font-bold tracking-tight text-ink">Pegasus Spatial</span>
        </Link>
        <div className="hidden items-center gap-6 md:flex">
          {navLinks.map(link => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                target={link.href.startsWith('/spatial/') ? '_blank' : undefined}
                rel={link.href.startsWith('/spatial/') ? 'noreferrer' : undefined}
                className={`text-sm transition-colors ${active ? 'font-semibold text-primary' : 'text-ink-muted hover:text-ink'}`}
              >
                {link.label}
              </Link>
            )
          })}
        </div>
      </div>
      <span className="rounded-full border border-outline-variant/20 bg-surface-mid px-3 py-1.5 text-xs font-medium text-ink-muted">
        本地演示
      </span>
    </nav>
  )
}
