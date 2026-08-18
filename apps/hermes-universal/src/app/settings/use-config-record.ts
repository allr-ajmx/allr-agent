import { useQuery } from '@tanstack/react-query'

import { getHermesConfigRecord } from '@/hermes'
import { queryClient, writeCache } from '@/lib/query-client'
import type { HermesConfigRecord } from '@/types/hermes'

// One shared cache for the whole profile config record (`GET /api/config`). Every
// settings surface reads and writes through this key so a save in one shows in
// the others, and revisiting a section paints the cache instead of blanking on a
// fresh fetch. Ported from apps/desktop/src/app/hooks/use-config-record.ts.
export const ALLR_CONFIG_KEY = ['hermes-config-record'] as const

// staleTime 0 → serve cache instantly, background-revalidate on every mount.
export const useHermesConfigRecord = () =>
  useQuery({ queryKey: ALLR_CONFIG_KEY, queryFn: getHermesConfigRecord, staleTime: 0 })

export const setHermesConfigCache = writeCache<HermesConfigRecord>(ALLR_CONFIG_KEY)

export const invalidateHermesConfig = () => queryClient.invalidateQueries({ queryKey: ALLR_CONFIG_KEY })
