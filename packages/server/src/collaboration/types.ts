export interface PlatformDiscussion {
  id: string;
  resolved: boolean;
  notes: Array<{ id: string; author: string; body: string; createdAt: string; url: string }>;
}
export interface PlatformDiscussionReader {
  getDiscussions(repositoryId: string, iid: number): Promise<PlatformDiscussion[]>;
}
export interface DiscussionComment {
  id: string; authorId: string; authorName: string; parentId: string | null;
  body: string; mentions: string[]; createdAt: string;
}
export class CollaborationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
