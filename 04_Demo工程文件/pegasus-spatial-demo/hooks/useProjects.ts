'use client'

import { useState, useEffect, useCallback } from 'react'
import type { FileEntry } from '@/lib/workspace/types'

export interface ProjectSummary {
  conversation_id: string
  title: string
  settings?: {
    research_domain?: string
  }
  output?: {
    files?: Record<string, FileEntry>
  }
  created_at: string
  updated_at: string
}

interface UseProjectsResult {
  projects: ProjectSummary[]
  total: number
  page: number
  totalPages: number
  isLoading: boolean
  search: string
  setSearch: (s: string) => void
  loadMore: () => void
  deleteProject: (id: string) => Promise<boolean>
  renameProject: (id: string, title: string) => Promise<boolean>
  refresh: () => void
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [isLoading, setIsLoading] = useState(false)
  const [search, setSearch] = useState('')

  const fetchPage = useCallback(async (pageNum: number, query: string, append: boolean) => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams({ page: String(pageNum), limit: '20' })
      if (query.trim()) params.set('search', query.trim())
      const res = await fetch(`/api/projects?${params}`)
      if (res.ok) {
        const data = await res.json()
        setProjects(prev => append ? [...prev, ...data.projects] : data.projects)
        setTotal(data.total)
        setPage(data.page)
        setTotalPages(data.totalPages)
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPage(1, search, false)
  }, [search, fetchPage])

  const loadMore = useCallback(() => {
    if (page < totalPages && !isLoading) {
      fetchPage(page + 1, search, true)
    }
  }, [page, totalPages, isLoading, search, fetchPage])

  const deleteProject = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setProjects(prev => prev.filter(p => p.conversation_id !== id))
        setTotal(prev => prev - 1)
      }
      return res.ok
    } catch {
      return false
    }
  }, [])

  const renameProject = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return false
    // Optimistic update — snapshot prior state so we can roll back if PATCH fails
    let prevTitle: string | undefined
    setProjects(prev => prev.map(p => {
      if (p.conversation_id === id) {
        prevTitle = p.title
        return { ...p, title: trimmed }
      }
      return p
    }))
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
      if (!res.ok) throw new Error('rename failed')
      return true
    } catch {
      // Roll back optimistic update
      if (prevTitle !== undefined) {
        setProjects(prev => prev.map(p =>
          p.conversation_id === id ? { ...p, title: prevTitle as string } : p
        ))
      }
      return false
    }
  }, [])

  const refresh = useCallback(() => {
    fetchPage(1, search, false)
  }, [search, fetchPage])

  return { projects, total, page, totalPages, isLoading, search, setSearch, loadMore, deleteProject, renameProject, refresh }
}
