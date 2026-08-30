'use client'

/**
 * MemoryHero —— 本地容量 + 记忆突触场(demo-e 融合版)
 *
 * 左侧容量数据(记忆空间/画像/历史/可用),右侧活性突触网络——替代旧 atlas
 * 的静态 SVG 关系图。纸面容器(--paper)承载,突触场绝对铺满并经左侧 mask 渐隐。
 */
import { MemorySynapseField } from './MemorySynapseField'
import styles from './MemoryHero.module.css'

export interface MemoryHeroProps {
  usedTokens: number
  limitTokens: number
  profileTokens: number
  historyTokens: number
  remainingTokens: number
  usageRatio: number
  onViewHistory: () => void
}

const formatTokens = (value: number) => value >= 1_000
  ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`
  : String(value)

export function MemoryHero({
  usedTokens,
  limitTokens,
  profileTokens,
  historyTokens,
  remainingTokens,
  usageRatio,
  onViewHistory,
}: MemoryHeroProps) {
  const percent = Math.min(100, Math.round(usageRatio * 100))

  return (
    <section className={styles.hero}>
      <MemorySynapseField />
      <div className={styles.capacity}>
        <p className={styles.kicker}>本地容量</p>
        <div className={styles.heading}>
          <h2>记忆空间</h2>
          <span className={styles.percent}>已使用 {percent}%</span>
        </div>
        <div className={styles.value}>
          <strong>{formatTokens(usedTokens)}</strong>
          <span>/ {formatTokens(limitTokens)} tokens</span>
        </div>
        <div className={styles.track} role="img" aria-label={`记忆空间已使用 ${percent}%`}>
          <i style={{ width: `${percent}%` }} />
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}><b>{formatTokens(profileTokens)}</b><span>长期画像</span></div>
          <div className={styles.stat}><b>{formatTokens(historyTokens)}</b><span>历史索引</span></div>
          <div className={styles.stat}><b>{formatTokens(remainingTokens)}</b><span>可用空间</span></div>
        </div>
        <div className={styles.foot}>
          <p>长期画像与历史索引共用本地项目记忆空间。</p>
          <button type="button" onClick={onViewHistory}>查看历史</button>
        </div>
      </div>
    </section>
  )
}
