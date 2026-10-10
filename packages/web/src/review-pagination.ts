export function resolveReviewPage(page: number, total: number, pageSize: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(page, pages), pages };
}
