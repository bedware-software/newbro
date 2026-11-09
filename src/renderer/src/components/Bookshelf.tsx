// The Bookshelf's data: a reading list per profile (src/main/bookshelf.ts) —
// readings to read, in groups if you like, and an archive of the ones read.
// The shelf itself is a page now (vimperium://bookshelf, tb):
// components/BookshelfPage.tsx.

export type ReadingStatus = 'toread' | 'archived'

export interface Reading {
  id: string
  url: string
  title: string
  favicon?: string
  status: ReadingStatus
  addedAt: number
  groupId?: string
  offlinePath?: string
}

export interface ReadingGroup {
  id: string
  name: string
  color: string
  isCollapsed: boolean
}
