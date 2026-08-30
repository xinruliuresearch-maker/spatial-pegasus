import type { Metadata } from 'next'
import './globals.css'
import { AppProviders } from '@/components/providers/AppProviders'
import { ChatProvider } from '@/contexts/ChatContext'

export const metadata: Metadata = {
  title: {
    default: 'Pegasus Spatial',
    template: '%s · Pegasus Spatial',
  },
  description: '用自然语言驱动图像生成、3D 造物、世界生成与现实重建的空间创作 Agent',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const mediaCdnOrigin = process.env.NEXT_PUBLIC_MEDIA_CDN_BASE_URL?.trim()
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      {mediaCdnOrigin && (
        <head>
          <link rel="dns-prefetch" href={mediaCdnOrigin} />
          <link rel="preconnect" href={mediaCdnOrigin} crossOrigin="anonymous" />
        </head>
      )}
      <body className="antialiased">
        <AppProviders>
          <ChatProvider>{children}</ChatProvider>
        </AppProviders>
      </body>
    </html>
  )
}
