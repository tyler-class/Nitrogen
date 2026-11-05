import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page, PageDetail, TreeResponse } from '@shared/types';
import { api } from './api';

export const keys = {
  tree: ['tree'] as const,
  page: (id: string) => ['page', id] as const,
  revisions: (id: string) => ['revisions', id] as const,
  settings: ['settings'] as const,
};

export function useTree() {
  return useQuery({
    queryKey: keys.tree,
    queryFn: () => api.get<TreeResponse>('/tree'),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function usePage(id: string | undefined) {
  return useQuery({
    queryKey: keys.page(id ?? 'none'),
    queryFn: () => api.get<PageDetail>(`/pages/${id}`),
    enabled: !!id,
    staleTime: 5_000,
  });
}

/** Refreshes the tree and any open page after a structural change. */
export function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.tree });
    void qc.invalidateQueries({ queryKey: ['page'] });
  };
}

export function useCreatePage() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { title: string; parent_id: string | null; position?: number }) =>
      api.post<Page>('/pages', input),
    onSuccess: invalidate,
  });
}

export function useMovePage() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; parent_id: string | null; position?: number }) =>
      api.post<Page>(`/pages/${id}/move`, input),
    onSuccess: invalidate,
  });
}

export function useRenamePage() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; title?: string; icon?: string | null }) =>
      api.patch<Page>(`/pages/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeletePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: number }>(`/pages/${id}`),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: keys.page(id) });
      void qc.invalidateQueries({ queryKey: keys.tree });
      void qc.invalidateQueries({ queryKey: ['page'] });
    },
  });
}
